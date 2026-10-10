import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { openTestDb, setDbForTests, newId, nowIso, sha256Hex } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";
import { createApiKey, resetUsageThrottle } from "../src/services/apiKeys.js";
import { resetLimits } from "../src/api/limits.js";

const PREFIX = /^kct_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;

async function makeUser(
  db: Database,
  opts: { email: string; password: string; role?: "admin" | "user"; name?: string }
): Promise<string> {
  const id = newId("usr");
  const now = nowIso();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"
  ).run(id, opts.email.toLowerCase(), opts.name ?? "Test", await hashPassword(opts.password), opts.role ?? "user", opts.email.toLowerCase(), now, now);
  return id;
}

describe("API key lifecycle and authorization", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let admin: ReturnType<typeof request.agent>;
  let adminId: string;
  let userId: string;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CORS_ORIGINS", "");
    vi.stubEnv("LOGIN_RATE_LIMIT_MAX", "1000");
    db = openTestDb();
    setDbForTests(db);
    resetLimits();
    resetUsageThrottle();
    adminId = await makeUser(db, { email: "admin@test.local", password: "AdminPass12345", role: "admin" });
    userId = await makeUser(db, { email: "user@test.local", password: "UserPass12345", role: "user" });
    app = createApp();
    admin = request.agent(app);
    await admin.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
  });

  async function createKey(body: Record<string, unknown>) {
    const res = await admin.post("/api/admin/api-keys").send(body);
    expect(res.status).toBe(201);
    return res.body.data as { key: { id: string; key_prefix: string }; secret: string };
  }

  function bearer(token: string) {
    return request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
  }

  it("stores only a hash of the secret and never returns it twice", async () => {
    const { key, secret } = await createKey({ name: "CI deploy", scopes: ["instances:read"] });
    expect(secret).toMatch(PREFIX);
    expect(secret.startsWith(key.key_prefix)).toBe(true);

    const row = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(key.id) as { key_hash: string };
    expect(row.key_hash).toBe(sha256Hex(secret));
    expect(row.key_hash).not.toBe(secret);
    expect(JSON.stringify(db.prepare("SELECT * FROM api_keys").all())).not.toContain(secret);

    // Reading it back (session or API) must not include the secret or the hash.
    const read = await admin.get(`/api/admin/api-keys/${key.id}`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(secret);
    expect(read.body.data.key.key_hash).toBeUndefined();
  });

  it("authenticates a valid key and reports the calling identity", async () => {
    const { secret, key } = await createKey({ name: "Read only", scopes: ["system:read", "instances:read"] });
    const res = await bearer(secret);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("admin@test.local");
    expect(res.body.data.api_key.id).toBe(key.id);
    expect(res.body.data.api_key.scopes).toEqual(["system:read", "instances:read"]);
    expect(res.body.meta.request_id).toBeTruthy();
    expect(res.headers["x-request-id"]).toBe(res.body.meta.request_id);
  });

  it("rejects missing, malformed, unknown, expired, and revoked keys", async () => {
    const { secret, key } = await createKey({ name: "Temp", scopes: ["instances:read"] });

    const missing = await request(app).get("/api/v1/instances");
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("UNAUTHENTICATED");

    const malformed = await request(app).get("/api/v1/me").set("Authorization", "Basic nope");
    expect(malformed.status).toBe(401);
    expect(malformed.body.error.code).toBe("INVALID_AUTH_HEADER");

    const unknown = await bearer("kct_live_0123456789ab_" + "a".repeat(43));
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("INVALID_API_KEY");

    db.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", key.id);
    const expired = await bearer(secret);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("API_KEY_EXPIRED");

    resetUsageThrottle();
    const { secret: s2, key: k2 } = await createKey({ name: "To revoke", scopes: ["instances:read"] });
    await admin.delete(`/api/admin/api-keys/${k2.id}`);
    const revoked = await bearer(s2);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe("API_KEY_REVOKED");
  });

  it("enforces scopes and fails closed on unknown endpoints", async () => {
    const { secret } = await createKey({ name: "Instances only", scopes: ["instances:read"] });
    const forbidden = await request(app).get("/api/v1/nodes").set("Authorization", `Bearer ${secret}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("INSUFFICIENT_SCOPE");

    const { secret: full } = await createKey({ name: "Full", scopes: ["*"] });
    const unknown = await request(app).get("/api/v1/does-not-exist").set("Authorization", `Bearer ${full}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
  });

  it("never lets a scope grant the administrator role", async () => {
    const created = createApiKey(db, { name: "User full", scopes: ["*"], createdBy: userId, expiresAt: null, ipAllowlist: [] });
    const res = await request(app).get("/api/v1/nodes").set("Authorization", `Bearer ${created.secret}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("honours IP restrictions", async () => {
    const { secret } = await createKey({ name: "Office", scopes: ["system:read"], ip_allowlist: ["203.0.113.0/24"] });
    const denied = await bearer(secret);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("IP_NOT_ALLOWED");

    const allowed = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${secret}`).set("X-Forwarded-For", "203.0.113.7");
    expect(allowed.status).toBe(200);
  });

  it("lets a key manage only its own children and never escalate", async () => {
    const parent = await createKey({ name: "Parent", scopes: ["api_keys:read", "api_keys:create", "api_keys:revoke", "instances:read"] });
    const other = await createKey({ name: "Sibling", scopes: ["instances:read"] });

    const child = await request(app)
      .post("/api/v1/api-keys")
      .set("Authorization", `Bearer ${parent.secret}`)
      .send({ name: "Child", scopes: ["instances:read"] });
    expect(child.status).toBe(201);

    const list = await request(app).get("/api/v1/api-keys").set("Authorization", `Bearer ${parent.secret}`);
    expect(list.status).toBe(200);
    const ids = list.body.data.keys.map((k: { id: string }) => k.id);
    expect(ids).toContain(child.body.data.key.id);
    expect(ids).not.toContain(other.key.id);

    const peek = await request(app).get(`/api/v1/api-keys/${other.key.id}`).set("Authorization", `Bearer ${parent.secret}`);
    expect(peek.status).toBe(404);

    const escalate = await request(app)
      .post("/api/v1/api-keys")
      .set("Authorization", `Bearer ${parent.secret}`)
      .send({ name: "Too broad", scopes: ["nodes:read"] });
    expect(escalate.status).toBe(400);
    expect(escalate.body.error.code).toBe("VALIDATION");
  });

  it("bounds child expiry by the parent's expiry", async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const parent = await createKey({ name: "Parent", scopes: ["api_keys:create"], expires_at: soon });
    const res = await request(app)
      .post("/api/v1/api-keys")
      .set("Authorization", `Bearer ${parent.secret}`)
      .send({ name: "Outlives", scopes: ["api_keys:create"], expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe("expires_at");
  });

  it("rotates a key and optionally revokes the original", async () => {
    const { secret, key } = await createKey({ name: "Rotate me", scopes: ["system:read"] });
    const rotated = await admin.post(`/api/admin/api-keys/${key.id}/rotate`).send({ revoke_old: false });
    expect(rotated.status).toBe(201);
    expect(rotated.body.data.secret).toMatch(PREFIX);
    expect((await bearer(secret)).status).toBe(200);
    expect((await bearer(rotated.body.data.secret)).status).toBe(200);

    resetUsageThrottle();
    const oldAfter = await admin
      .post(`/api/admin/api-keys/${rotated.body.data.key.id}/rotate`)
      .send({ revoke_old: true });
    expect(oldAfter.status).toBe(201);
    expect((await bearer(rotated.body.data.secret)).status).toBe(401);
  });

  it("applies sensitive and general rate limits with standard headers", async () => {
    const { secret } = await createKey({ name: "Hammer", scopes: ["api_keys:create", "api_keys:read"] });
    let limited = false;
    let last: request.Response | undefined;
    for (let i = 0; i < 25; i += 1) {
      last = await request(app).post("/api/v1/api-keys").set("Authorization", `Bearer ${secret}`).send({ name: `Child ${i}`, scopes: ["api_keys:read"] });
      if (last.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    expect(last!.headers["retry-after"]).toBeTruthy();
    expect(last!.body.error.code).toBe("RATE_LIMITED");
  });

  it("throttles repeated credential failures", async () => {
    vi.stubEnv("API_AUTH_FAILURE_LIMIT", "3");
    resetLimits();
    for (let i = 0; i < 3; i += 1) {
      const res = await bearer("kct_live_0123456789ab_" + "b".repeat(43));
      expect(res.status).toBe(401);
    }
    const throttled = await bearer("kct_live_0123456789ab_" + "b".repeat(43));
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe("RATE_LIMITED");
  });
});
