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

function makeInstance(db: ReturnType<typeof openTestDb>, ownerId: string, name: string): string {
  const id = newId("vps");
  const now = nowIso();
  db.prepare(
    "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, template, created_at, updated_at) VALUES (?, ?, ?, 'local', ?, 'stopped', 1, 512, 10, 'alpine-3.20', ?, ?)"
  ).run(id, name, name, ownerId, now, now);
  return id;
}

describe("instance administrator notes", () => {
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

  function dbNotes(id: string): string | null {
    return (getDb().prepare("SELECT notes FROM instances WHERE id = ?").get(id) as { notes: string | null }).notes;
  }

  it("starts with no note and lets an administrator set one that everyone can read", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    const before = await aliceAgent.get(`/api/instances/${aliceInstance}`);
    expect(before.body.data.instance.notes).toBeNull();

    const admin = await login("admin@test.local", "AdminPass12345");
    const text = "Renewal due 2026-11-01.\nContact alice@test.local before suspending.";
    const saved = await admin.patch(`/api/instances/${aliceInstance}/notes`).send({ notes: text });
    expect(saved.status).toBe(200);
    expect(saved.body.data.instance.notes).toBe(text);
    expect(dbNotes(aliceInstance)).toBe(text);

    // Included in the admin list/detail too.
    const adminDetail = await admin.get(`/api/admin/instances/${aliceInstance}`);
    expect(adminDetail.body.data.instance.notes).toBe(text);

    // The owner sees the same note (read-only) on detail and in the dashboard list.
    const after = await aliceAgent.get(`/api/instances/${aliceInstance}`);
    expect(after.body.data.instance.notes).toBe(text);
    const list = await aliceAgent.get("/api/instances");
    expect(list.body.data.instances[0].notes).toBe(text);

    const db = getDb();
    const events = db
      .prepare("SELECT detail FROM audit_events WHERE target_id = ? AND action = 'instance.notes'")
      .all(aliceInstance) as { detail: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detail)).toMatchObject({ length: text.length, cleared: false });
  });

  it("clears the note with an empty or whitespace-only value", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    await admin.patch(`/api/instances/${aliceInstance}/notes`).send({ notes: "temporary" });
    expect(dbNotes(aliceInstance)).toBe("temporary");

    const cleared = await admin.patch(`/api/instances/${aliceInstance}/notes`).send({ notes: "   \n  " });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.instance.notes).toBeNull();
    expect(dbNotes(aliceInstance)).toBeNull();

    const db = getDb();
    const events = db
      .prepare("SELECT detail FROM audit_events WHERE target_id = ? AND action = 'instance.notes' ORDER BY created_at ASC")
      .all(aliceInstance) as { detail: string }[];
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]!.detail)).toMatchObject({ cleared: true });
  });

  it("only lets administrators change the note, while owners and others may read", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    const ownerAttempt = await aliceAgent.patch(`/api/instances/${aliceInstance}/notes`).send({ notes: "owner edit" });
    expect(ownerAttempt.status).toBe(403);
    expect(ownerAttempt.body.error.code).toBe("FORBIDDEN");
    expect(dbNotes(aliceInstance)).toBeNull();

    // Bob cannot even see the instance (and certainly cannot annotate it).
    const bobAgent = await login("bob@test.local", "BobPass12345");
    expect((await bobAgent.patch(`/api/instances/${aliceInstance}/notes`).send({ notes: "hi" })).status).toBe(404);

    const anon = request(app);
    expect((await anon.patch(`/api/instances/${aliceInstance}/notes`).send({ notes: "hi" })).status).toBe(401);

    // The admin sets it; the owner can then read it.
    const admin = await login("admin@test.local", "AdminPass12345");
    await admin.patch(`/api/instances/${aliceInstance}/notes`).send({ notes: "admin note" });
    const read = await aliceAgent.get(`/api/instances/${aliceInstance}`);
    expect(read.body.data.instance.notes).toBe("admin note");
  });

  it("validates the note payload", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    expect((await admin.patch(`/api/instances/${aliceInstance}/notes`).send({})).status).toBe(400);
    expect((await admin.patch(`/api/instances/${aliceInstance}/notes`).send({ notes: 42 })).status).toBe(400);
    const tooLong = await admin
      .patch(`/api/instances/${aliceInstance}/notes`)
      .send({ notes: "x".repeat(4001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("VALIDATION");
    expect(dbNotes(aliceInstance)).toBeNull();

    // Exactly at the limit is accepted.
    const atLimit = await admin
      .patch(`/api/instances/${aliceInstance}/notes`)
      .send({ notes: "y".repeat(4000) });
    expect(atLimit.status).toBe(200);
    expect(dbNotes(aliceInstance)).toHaveLength(4000);
  });

  it("leaves the note untouched by suspension and live reconciliation", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    await admin.patch(`/api/instances/${aliceInstance}/notes`).send({ notes: "keep me" });
    await admin.post(`/api/instances/${aliceInstance}/suspend`).send({});

    const detail = await admin.get(`/api/instances/${aliceInstance}`);
    expect(detail.body.data.instance.status).toBe("suspended");
    expect(detail.body.data.instance.notes).toBe("keep me");
  });

  it("enforces the metadata scope and the administrator role on the versioned API", async () => {
    const db = getDb();
    // A key without the scope is refused by the scope guard.
    const reader = createApiKey(db, { name: "Reader", scopes: ["instances:read"], createdBy: adminId, expiresAt: null, ipAllowlist: [] });
    const noScope = await request(app)
      .patch(`/api/v1/instances/${aliceInstance}/notes`)
      .set("Authorization", `Bearer ${reader.secret}`)
      .send({ notes: "nope" });
    expect(noScope.status).toBe(403);
    expect(noScope.body.error.code).toBe("INSUFFICIENT_SCOPE");

    // Scope is not enough: a non-admin owner's key still fails the admin check.
    const ownerKey = createApiKey(db, { name: "Owner key", scopes: ["instances:settings:write"], createdBy: alice, expiresAt: null, ipAllowlist: [] });
    const ownerAttempt = await request(app)
      .patch(`/api/v1/instances/${aliceInstance}/notes`)
      .set("Authorization", `Bearer ${ownerKey.secret}`)
      .send({ notes: "owner edit" });
    expect(ownerAttempt.status).toBe(403);
    expect(ownerAttempt.body.error.code).toBe("FORBIDDEN");
    expect(dbNotes(aliceInstance)).toBeNull();

    // An administrator-issued key with the scope succeeds.
    const adminKey = createApiKey(db, { name: "Admin key", scopes: ["instances:settings:write"], createdBy: adminId, expiresAt: null, ipAllowlist: [] });
    const ok = await request(app)
      .patch(`/api/v1/instances/${aliceInstance}/notes`)
      .set("Authorization", `Bearer ${adminKey.secret}`)
      .send({ notes: "via api" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.instance.notes).toBe("via api");
    expect(dbNotes(aliceInstance)).toBe("via api");
  });
});
