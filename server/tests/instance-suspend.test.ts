import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { openTestDb, setDbForTests, getDb, newId, nowIso } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";
import { createApiKey } from "../src/services/apiKeys.js";

async function makeUser(
  db: ReturnType<typeof openTestDb>,
  opts: { email: string; password: string; role?: "admin" | "user"; name?: string }
): Promise<string> {
  const id = newId("usr");
  const now = nowIso();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"
  ).run(id, opts.email.toLowerCase(), opts.name ?? "Test", await hashPassword(opts.password), opts.role ?? "user", opts.email.toLowerCase(), now, now);
  return id;
}

function makeInstance(db: ReturnType<typeof openTestDb>, ownerId: string, name: string, status = "stopped"): string {
  const id = newId("vps");
  const now = nowIso();
  db.prepare(
    "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, template, created_at, updated_at) VALUES (?, ?, ?, 'local', ?, ?, 1, 512, 10, 'alpine-3.20', ?, ?)"
  ).run(id, name, name, ownerId, status, now, now);
  return id;
}

describe("instance suspension", () => {
  let app: ReturnType<typeof createApp>;
  let adminId = "";
  let alice = "";
  let aliceInstance = "";

  beforeEach(async () => {
    const db = openTestDb();
    setDbForTests(db);
    vi.stubEnv("CORS_ORIGINS", "");
    adminId = await makeUser(db, { email: "admin@test.local", password: "AdminPass12345", role: "admin", name: "Admin" });
    alice = await makeUser(db, { email: "alice@test.local", password: "AlicePass12345", name: "Alice" });
    await makeUser(db, { email: "bob@test.local", password: "BobPass12345", name: "Bob" });
    aliceInstance = makeInstance(db, alice, "alice-web");
    app = createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function login(email: string, password: string) {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email, password });
    return agent;
  }

  function dbStatus(id: string): string {
    return (getDb().prepare("SELECT status FROM instances WHERE id = ?").get(id) as { status: string }).status;
  }

  it("suspends a stopped instance and audits the hold", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const res = await admin.post(`/api/instances/${aliceInstance}/suspend`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.instance.status).toBe("suspended");
    expect(dbStatus(aliceInstance)).toBe("suspended");

    const db = (await import("../src/db.js")).getDb();
    const events = db.prepare("SELECT action, detail FROM audit_events WHERE target_id = ? AND action = 'instance.suspend'").all(aliceInstance) as {
      action: string;
      detail: string;
    }[];
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0]!.detail) as Record<string, unknown>;
    expect(detail.previous_status).toBe("stopped");

    // Second suspend conflicts instead of duplicating the hold.
    const again = await admin.post(`/api/instances/${aliceInstance}/suspend`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_SUSPENDED");
  });

  it("blocks power operations while suspended but allows deletion attempts", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    await admin.post(`/api/instances/${aliceInstance}/suspend`).send({});

    for (const action of ["start", "stop", "restart"]) {
      const res = await admin.post(`/api/instances/${aliceInstance}/actions`).send({ action });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSTANCE_SUSPENDED");
    }
    expect(dbStatus(aliceInstance)).toBe("suspended");

    // A failed destroy must not silently drop the record.
    const remove = await admin.post(`/api/instances/${aliceInstance}/actions`).send({ action: "remove" });
    expect(remove.status).toBe(502); // no LXC tooling on the test box
    const db = (await import("../src/db.js")).getDb();
    expect(db.prepare("SELECT COUNT(*) AS n FROM instances WHERE id = ?").get(aliceInstance) as { n: number }).toMatchObject({ n: 1 });
    expect(dbStatus(aliceInstance)).toBe("suspended");
  });

  it("rejects suspend and unsuspend for unauthorized callers", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    expect((await aliceAgent.post(`/api/instances/${aliceInstance}/suspend`).send({})).status).toBe(403);
    expect((await aliceAgent.post(`/api/instances/${aliceInstance}/unsuspend`).send({})).status).toBe(403);

    const bobAgent = await login("bob@test.local", "BobPass12345");
    expect((await bobAgent.post(`/api/instances/${aliceInstance}/suspend`).send({})).status).toBe(404);
    expect((await bobAgent.post(`/api/instances/${aliceInstance}/unsuspend`).send({})).status).toBe(404);

    const anon = request(app);
    expect((await anon.post(`/api/instances/${aliceInstance}/suspend`).send({})).status).toBe(401);
    expect(dbStatus(aliceInstance)).toBe("stopped");
  });

  it("unsuspends without starting and reconciles honestly", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    await admin.post(`/api/instances/${aliceInstance}/suspend`).send({});

    const res = await admin.post(`/api/instances/${aliceInstance}/unsuspend`).send({});
    expect(res.status).toBe(200);
    // No LXC tooling on the test box: host state is unknown, never invented.
    expect(res.body.data.instance.status).toBe("unknown");
    expect(res.body.data.live.exists).toBeNull();
    expect(dbStatus(aliceInstance)).toBe("unknown");

    const db = (await import("../src/db.js")).getDb();
    const events = db.prepare("SELECT detail FROM audit_events WHERE target_id = ? AND action = 'instance.unsuspend'").all(aliceInstance) as {
      detail: string;
    }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detail)).toMatchObject({ previous_status: "suspended", status: "unknown" });

    const again = await admin.post(`/api/instances/${aliceInstance}/unsuspend`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("NOT_SUSPENDED");
  });

  it("never reconciles a suspension away on read", async () => {
    const db = (await import("../src/db.js")).getDb();
    db.prepare("UPDATE instances SET status = 'suspended' WHERE id = ?").run(aliceInstance);
    const admin = await login("admin@test.local", "AdminPass12345");

    const detail = await admin.get(`/api/instances/${aliceInstance}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.instance.status).toBe("suspended");

    const adminDetail = await admin.get(`/api/admin/instances/${aliceInstance}`);
    expect(adminDetail.status).toBe(200);
    expect(adminDetail.body.data.instance.status).toBe("suspended");

    const list = await admin.get("/api/admin/instances?status=suspended");
    expect(list.body.data.instances.map((i: { id: string }) => i.id)).toContain(aliceInstance);

    const stats = await admin.get("/api/admin/instances/stats");
    expect(stats.body.data.stats.suspended).toBe(1);
  });

  it("enforces the suspend scope on the versioned API", async () => {
    const db = (await import("../src/db.js")).getDb();
    // Scopes never grant the administrator role: an owner-issued key with the
    // scope is still refused by the server-side admin check.
    const ownerKey = createApiKey(db, { name: "Owner key", scopes: ["instances:suspend"], createdBy: alice, expiresAt: null, ipAllowlist: [] });
    const ownerAttempt = await request(app)
      .post(`/api/v1/instances/${aliceInstance}/suspend`)
      .set("Authorization", `Bearer ${ownerKey.secret}`)
      .send({});
    expect(ownerAttempt.status).toBe(403);
    expect(ownerAttempt.body.error.code).toBe("FORBIDDEN");
    expect(dbStatus(aliceInstance)).toBe("stopped");

    const full = createApiKey(db, { name: "Suspender", scopes: ["instances:suspend"], createdBy: adminId, expiresAt: null, ipAllowlist: [] });
    const suspended = await request(app)
      .post(`/api/v1/instances/${aliceInstance}/suspend`)
      .set("Authorization", `Bearer ${full.secret}`)
      .send({});
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.instance.status).toBe("suspended");

    const reader = createApiKey(db, { name: "Reader", scopes: ["instances:read"], createdBy: adminId, expiresAt: null, ipAllowlist: [] });
    const denied = await request(app)
      .post(`/api/v1/instances/${aliceInstance}/unsuspend`)
      .set("Authorization", `Bearer ${reader.secret}`)
      .send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("INSUFFICIENT_SCOPE");
    expect(dbStatus(aliceInstance)).toBe("suspended");

    const lifted = await request(app)
      .post(`/api/v1/instances/${aliceInstance}/unsuspend`)
      .set("Authorization", `Bearer ${full.secret}`)
      .send({});
    expect(lifted.status).toBe(200);
  });

  it("keeps the owner dashboard listing suspended instances honestly", async () => {
    const db = (await import("../src/db.js")).getDb();
    db.prepare("UPDATE instances SET status = 'suspended' WHERE id = ?").run(aliceInstance);
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    const res = await aliceAgent.get("/api/instances");
    expect(res.body.data.instances).toHaveLength(1);
    expect(res.body.data.instances[0].status).toBe("suspended");
    // Owners cannot power a suspended VPS back on themselves.
    expect((await aliceAgent.post(`/api/instances/${aliceInstance}/actions`).send({ action: "start" })).status).toBe(403);
  });
});
