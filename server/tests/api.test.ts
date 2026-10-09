import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { openTestDb, setDbForTests, newId, nowIso } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";

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

describe("KineticCT API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const db = openTestDb();
    setDbForTests(db);
    vi.stubEnv("CORS_ORIGINS", "");
    await makeUser(db, { email: "admin@test.local", password: "AdminPass12345", role: "admin", name: "Admin" });
    await makeUser(db, { email: "user@test.local", password: "UserPass12345", role: "user", name: "User" });
    app = createApp();
  });

  it("rejects invalid credentials with a generic error", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "user@test.local", password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects unknown emails without disclosing registration", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "nobody@test.local", password: "whatever123" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("logs in and serves the session", async () => {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/login").send({ email: "user@test.local", password: "UserPass12345" });
    expect(res.status).toBe(200);
    const me = await agent.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe("user@test.local");
  });

  it("rejects unauthenticated access to protected routes", async () => {
    expect((await request(app).get("/api/me")).status).toBe(401);
    expect((await request(app).get("/api/instances")).status).toBe(401);
    expect((await request(app).get("/api/admin/overview")).status).toBe(401);
  });

  it("forbids ordinary users from admin APIs", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "user@test.local", password: "UserPass12345" });
    expect((await agent.get("/api/admin/overview")).status).toBe(403);
    expect((await agent.get("/api/admin/users")).status).toBe(403);
    expect((await agent.get("/api/settings")).status).toBe(403);
  });

  it("isolates instances per user", async () => {
    const db = (await import("../src/db.js")).getDb();
    const alice = await makeUser(db, { email: "alice@test.local", password: "AlicePass12345" });
    const bob = await makeUser(db, { email: "bob@test.local", password: "BobPass12345" });
    const now = nowIso();
    db.prepare(
      "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, template, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'stopped', 1, 512, 10, 'ubuntu-22.04', ?, ?)"
    ).run(newId("vps"), "alice-box", "alice-box", alice, now, now);

    const aliceAgent = request.agent(app);
    await aliceAgent.post("/api/auth/login").send({ email: "alice@test.local", password: "AlicePass12345" });
    const list = await aliceAgent.get("/api/instances");
    expect(list.body.data.instances).toHaveLength(1);

    const bobAgent = request.agent(app);
    await bobAgent.post("/api/auth/login").send({ email: "bob@test.local", password: "BobPass12345" });
    const bobList = await bobAgent.get("/api/instances");
    expect(bobList.body.data.instances).toHaveLength(0);
    const instanceId = list.body.data.instances[0].id;
    expect((await bobAgent.get(`/api/instances/${instanceId}`)).status).toBe(404);
    void bob;
  });

  it("disables public registration by default (server-side)", async () => {
    const res = await request(app).post("/api/auth/register").send({ email: "new@test.local", password: "NewPass12345", name: "New" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("REGISTRATION_DISABLED");
  });

  it("honestly reports unconfigured infrastructure on create", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
    const users = await agent.get("/api/admin/users");
    const owner = users.body.data.users.find((u: { email: string }) => u.email === "user@test.local").id;
    const res = await agent.post("/api/admin/instances").send({
      name: "web-01",
      node_id: "node_missing",
      owner_id: owner,
      template: "ubuntu-22.04",
      cpu: 1,
      memory_mb: 512,
      storage_gb: 10,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NODE_NOT_FOUND");
  });

  it("auto-registers the Local Node on a fresh database", async () => {
    const db = (await import("../src/db.js")).getDb();
    const rows = db.prepare("SELECT * FROM nodes WHERE id = 'local'").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Local Node");
    expect(rows[0].endpoint).toBe("local");
    expect(rows[0].node_type).toBe("local");
    expect(rows[0].provider).toBe("local-lxc");
    expect(Number(rows[0].is_protected)).toBe(1);
    const version = (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
    expect(version).toBeGreaterThanOrEqual(2);
  });

  it("never duplicates or overwrites the Local Node on re-initialization", async () => {
    const mod = await import("../src/db.js");
    const db = mod.getDb();
    db.prepare("UPDATE nodes SET name = ? WHERE id = 'local'").run("My Custom Host");
    mod.ensureLocalNode(db);
    mod.ensureLocalNode(db);
    const rows = db.prepare("SELECT * FROM nodes WHERE id = 'local' OR endpoint = 'local'").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("My Custom Host");
  });

  it("enforces admin-only access on node endpoints", async () => {
    const userAgent = request.agent(app);
    await userAgent.post("/api/auth/login").send({ email: "user@test.local", password: "UserPass12345" });
    expect((await userAgent.get("/api/nodes/local")).status).toBe(403);
    expect((await userAgent.post("/api/nodes/local/check")).status).toBe(403);
    expect((await userAgent.get("/api/nodes/local/containers")).status).toBe(403);
    expect((await userAgent.patch("/api/nodes/local").send({ name: "x" })).status).toBe(403);
    expect((await userAgent.delete("/api/nodes/local")).status).toBe(403);
    expect((await request(app).get("/api/nodes")).status).toBe(401);
  });

  it("refuses to delete the protected Local Node", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
    const res = await agent.delete("/api/nodes/local");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NODE_PROTECTED");
    const list = await agent.get("/api/nodes");
    expect(list.body.data.nodes.some((n: { id: string }) => n.id === "local")).toBe(true);
  });

  it("allows renaming the Local Node but never changing its identity", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
    const res = await agent.patch("/api/nodes/local").send({ name: "Renamed Host", endpoint: "remote", node_type: "remote" });
    expect(res.status).toBe(200);
    expect(res.body.data.node.name).toBe("Renamed Host");
    const fresh = await agent.get("/api/nodes/local");
    expect(fresh.body.data.node.endpoint).toBe("local");
    expect(fresh.body.data.node.node_type).toBe("local");
    expect(fresh.body.data.node.api_token).toBeUndefined();
  });

  it("rejects a second local node registration", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
    const res = await agent.post("/api/nodes").send({ name: "Another", connection: "local" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("LOCAL_NODE_EXISTS");
  });

  it("treats remote nodes honestly: saved as config, never operable", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
    const created = await agent.post("/api/nodes").send({ name: "Far Away", connection: "remote", host_address: "192.0.2.10" });
    expect(created.status).toBe(201);
    expect(created.body.data.node.status).toBe("unconfigured");
    expect(created.body.data.node.api_token).toBeUndefined();
    const id = created.body.data.node.id as string;
    const dup = await agent.post("/api/nodes").send({ name: "Dupe", connection: "remote", host_address: "192.0.2.10" });
    expect(dup.status).toBe(409);
    const check = await agent.post(`/api/nodes/${id}/check`);
    expect(check.status).toBe(409);
    expect(check.body.error.code).toBe("REMOTE_NODE_UNSUPPORTED");
    const inv = await agent.get(`/api/nodes/${id}/containers`);
    expect(inv.status).toBe(409);
    const removed = await agent.delete(`/api/nodes/${id}`);
    expect(removed.status).toBe(200);
  });

  it("reports real local health without fabricating success", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
    const res = await agent.post("/api/nodes/local/check");
    expect(res.status).toBe(200);
    expect(["online", "unconfigured", "error"]).toContain(res.body.data.check.status);
    expect(typeof res.body.data.check.detail).toBe("string");
  });

  it("merges duplicate local rows on upgrade without losing instances", async () => {
    const mod = await import("../src/db.js");
    const db = mod.getDb();
    const owner = await makeUser(db, { email: "dup@test.local", password: "DupPass12345" });
    const now = nowIso();
    // Simulate a pre-v2 database: no uniqueness guard, two local rows.
    db.exec("DROP INDEX IF EXISTS idx_nodes_local_single");
    db.prepare(
      "INSERT INTO nodes (id, name, endpoint, api_token, status, created_at, updated_at) VALUES (?, ?, 'local', '', 'unknown', ?, ?)"
    ).run("node_dup", "Duplicate", now, now);
    const instId = newId("vps");
    db.prepare(
      "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, created_at, updated_at) VALUES (?, 'd', 'dup-box', 'node_dup', ?, 'stopped', 1, 512, 10, ?, ?)"
    ).run(instId, owner, now, now);
    // Simulate a pre-v2 database, then upgrade.
    db.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    mod.migrate(db);
    const locals = db.prepare("SELECT id FROM nodes WHERE endpoint = 'local'").all() as { id: string }[];
    expect(locals).toHaveLength(1);
    expect(locals[0].id).toBe("local");
    const inst = db.prepare("SELECT node_id FROM instances WHERE id = ?").get(instId) as { node_id: string };
    expect(inst.node_id).toBe("local");
  });
});
