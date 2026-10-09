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
});
