import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { openTestDb, setDbForTests, newId, nowIso } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";
import { createApiKey } from "../src/services/apiKeys.js";
import { resetLimits } from "../src/api/limits.js";

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

function insertInstance(db: Database, ownerId: string, id: string, name: string): void {
  const now = nowIso();
  db.prepare(
    "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, template, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'stopped', 1, 512, 10, 'ubuntu-22.04', ?, ?)"
  ).run(id, name, `ct-${id}`, ownerId, now, now);
}

describe("/api/v1 surface", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let adminId: string;
  let userId: string;
  let adminToken: string;
  let userToken: string;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CORS_ORIGINS", "");
    db = openTestDb();
    setDbForTests(db);
    resetLimits();
    adminId = await makeUser(db, { email: "admin@test.local", password: "AdminPass12345", role: "admin" });
    userId = await makeUser(db, { email: "user@test.local", password: "UserPass12345", role: "user" });
    app = createApp();
    adminToken = createApiKey(db, { name: "Admin key", scopes: ["*"], createdBy: adminId }).secret;
    userToken = createApiKey(db, { name: "User key", scopes: ["instances:read", "system:read"], createdBy: userId }).secret;
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it("serves public metadata without authentication", async () => {
    const health = await request(app).get("/api/v1/health");
    expect(health.status).toBe(200);
    expect(health.body.data.status).toBe("ok");
    expect(health.body.data).not.toHaveProperty("env");

    const version = await request(app).get("/api/v1/version");
    expect(version.status).toBe(200);
    expect(version.body.data.api_version).toBe("v1");
    expect(version.body.data.contract.error).toContain("request_id");

    const capabilities = await request(app).get("/api/v1/capabilities");
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.data.features.interactive_console_over_api).toBe(false);
    expect(Array.isArray(capabilities.body.data.notes)).toBe(true);
  });

  it("adds request ids to every response", async () => {
    const ok = await request(app).get("/api/v1/health");
    expect(ok.headers["x-request-id"]).toBe(ok.body.meta.request_id);

    const err = await request(app).get("/api/v1/me");
    expect(err.status).toBe(401);
    expect(err.headers["x-request-id"]).toBe(err.body.error.request_id);
    expect(err.body.error.request_id).toBeTruthy();
  });

  it("returns only the caller's instances to ordinary accounts", async () => {
    insertInstance(db, userId, "inst_user", "user-box");
    insertInstance(db, adminId, "inst_admin", "admin-box");

    const asUser = await request(app).get("/api/v1/instances").set(auth(userToken));
    expect(asUser.status).toBe(200);
    expect(asUser.body.data.instances.map((i: { id: string }) => i.id)).toEqual(["inst_user"]);

    const asAdmin = await request(app).get("/api/v1/instances").set(auth(adminToken));
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.data.instances.length).toBe(2);
    expect(asAdmin.body.data.pagination.total).toBe(2);
  });

  it("exposes templates, settings, audit, and operations with scope checks", async () => {
    const templates = await request(app).get("/api/v1/templates").set(auth(userToken));
    expect(templates.status).toBe(200);
    expect(Array.isArray(templates.body.data.templates)).toBe(true);

    const publicSettings = await request(app).get("/api/v1/settings/public");
    expect(publicSettings.status).toBe(200);

    const settings = await request(app).get("/api/v1/settings").set(auth(userToken));
    expect(settings.status).toBe(403); // requires settings:read

    const audit = await request(app).get("/api/v1/audit/events").set(auth(adminToken));
    expect(audit.status).toBe(200);
    expect(Array.isArray(audit.body.data.events)).toBe(true);

    const operations = await request(app).get("/api/v1/operations").set(auth(adminToken));
    expect(operations.status).toBe(200);
    expect(Array.isArray(operations.body.data.operations)).toBe(true);
  });

  it("returns the scope catalogue for key administration", async () => {
    const res = await request(app).get("/api/v1/api-keys/scopes").set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.scopes.some((s: { id: string }) => s.id === "instances:read")).toBe(true);
    expect(res.body.data.full_access).toBe("*");
  });

  it("answers unknown API paths with JSON, never the SPA fallback", async () => {
    const res = await request(app).get("/api/v1/nope").set(auth(adminToken));
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("does not accept session cookies on the versioned API (Bearer only)", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
    const res = await agent.get("/api/v1/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });
});
