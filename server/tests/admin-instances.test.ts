import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { openTestDb, setDbForTests, newId, nowIso } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";

async function makeUser(
  db: ReturnType<typeof openTestDb>,
  opts: { email: string; password: string; role?: "admin" | "user"; name?: string; status?: string }
): Promise<string> {
  const id = newId("usr");
  const now = nowIso();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    opts.email.toLowerCase(),
    opts.name ?? "Test",
    await hashPassword(opts.password),
    opts.role ?? "user",
    opts.status ?? "active",
    opts.email.toLowerCase(),
    now,
    now
  );
  return id;
}

function makeInstance(
  db: ReturnType<typeof openTestDb>,
  ownerId: string,
  overrides: Record<string, unknown> = {}
): string {
  const id = newId("vps");
  const now = nowIso();
  db.prepare(
    "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    (overrides.name as string) ?? "web-01",
    (overrides.container_id as string) ?? `c-${id.slice(-6)}`,
    overrides.node_id === undefined ? "local" : (overrides.node_id as string | null),
    ownerId,
    (overrides.status as string) ?? "stopped",
    (overrides.cpu as number) ?? 2,
    (overrides.memory_mb as number) ?? 2048,
    (overrides.storage_gb as number) ?? 20,
    (overrides.template as string | null) ?? "ubuntu-22.04",
    now,
    now
  );
  return id;
}

describe("admin instances management", () => {
  let app: ReturnType<typeof createApp>;
  let alice = "";
  let bob = "";
  let aliceInstance = "";
  let bobInstance = "";

  beforeEach(async () => {
    const db = openTestDb();
    setDbForTests(db);
    vi.stubEnv("CORS_ORIGINS", "");
    await makeUser(db, { email: "admin@test.local", password: "AdminPass12345", role: "admin", name: "Admin" });
    alice = await makeUser(db, { email: "alice@test.local", password: "AlicePass12345", name: "Alice" });
    bob = await makeUser(db, { email: "bob@test.local", password: "BobPass12345", name: "Bob" });
    aliceInstance = makeInstance(db, alice, { name: "alice-web", container_id: "alice-web" });
    bobInstance = makeInstance(db, bob, { name: "bob-db", container_id: "bob-db", status: "running" });
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

  function auditActions(db: ReturnType<typeof openTestDb>, targetId: string): string[] {
    return (
      db.prepare("SELECT action FROM audit_events WHERE target_id = ? ORDER BY created_at").all(targetId) as {
        action: string;
      }[]
    ).map((r) => r.action);
  }

  it("lists every instance with owner and node info for admins", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const res = await admin.get("/api/admin/instances");
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBe(2);
    const instances = res.body.data.instances as Record<string, any>[];
    const byName = Object.fromEntries(instances.map((i) => [i.name, i]));
    expect(byName["alice-web"].owner.email).toBe("alice@test.local");
    expect(byName["alice-web"].owner.name).toBe("Alice");
    expect(byName["alice-web"].owner_id).toBe(alice);
    expect(byName["bob-db"].owner.email).toBe("bob@test.local");
    expect(byName["alice-web"].node.id).toBe("local");
    expect(byName["alice-web"].node.name).toBe("Local Node");
    // Owner records never leak credential material.
    expect(byName["alice-web"].owner.password_hash).toBeUndefined();
    // Live state is reported honestly: no LXC tooling on the test box.
    expect(byName["alice-web"].live.exists).toBeNull();
    expect(typeof byName["alice-web"].live.error).toBe("string");
  });

  it("rejects non-admins and anonymous callers on every admin instance endpoint", async () => {
    const bobAgent = await login("bob@test.local", "BobPass12345");
    const anon = request(app);
    for (const [method, path, body] of [
      ["get", "/api/admin/instances", undefined],
      ["get", "/api/admin/instances/stats", undefined],
      ["get", `/api/admin/instances/${aliceInstance}`, undefined],
      ["post", `/api/admin/instances/${aliceInstance}/transfer`, { target_user_id: bob }],
    ] as const) {
      const asBob =
        method === "get"
          ? await bobAgent.get(path)
          : await bobAgent.post(path).send(body);
      expect(asBob.status).toBe(403);
      const asAnon =
        method === "get" ? await anon.get(path) : await anon.post(path).send(body);
      expect(asAnon.status).toBe(401);
    }
  });

  it("searches across name, container, id, and owner fields", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const expectNames = async (q: string, names: string[]) => {
      const res = await admin.get(`/api/admin/instances?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(res.body.data.instances.map((i: any) => i.name).sort()).toEqual(names.sort());
    };
    await expectNames("alice-web", ["alice-web"]);
    await expectNames("bob-db", ["bob-db"]);
    await expectNames("alice@test.local", ["alice-web"]);
    await expectNames("Bob", ["bob-db"]);
    await expectNames(aliceInstance, ["alice-web"]);
    await expectNames("no-such-thing", []);
  });

  it("filters by status, node, owner, template and paginates", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const running = await admin.get("/api/admin/instances?status=running");
    expect(running.body.data.instances.map((i: any) => i.name)).toEqual(["bob-db"]);
    const stopped = await admin.get("/api/admin/instances?status=stopped");
    expect(stopped.body.data.instances.map((i: any) => i.name)).toEqual(["alice-web"]);
    const byOwner = await admin.get(`/api/admin/instances?owner_id=${bob}`);
    expect(byOwner.body.data.instances.map((i: any) => i.name)).toEqual(["bob-db"]);
    const byNode = await admin.get("/api/admin/instances?node_id=local");
    expect(byNode.body.data.pagination.total).toBe(2);
    const byTemplate = await admin.get("/api/admin/instances?template=ubuntu-22.04");
    expect(byTemplate.body.data.pagination.total).toBe(2);
    const otherTemplate = await admin.get("/api/admin/instances?template=debian-12");
    expect(otherTemplate.body.data.pagination.total).toBe(0);

    const p1 = await admin.get("/api/admin/instances?page=1&page_size=1&sort=name&order=asc");
    expect(p1.body.data.instances).toHaveLength(1);
    expect(p1.body.data.instances[0].name).toBe("alice-web");
    expect(p1.body.data.pagination).toMatchObject({ page: 1, page_size: 1, total: 2, pages: 2 });
    const p2 = await admin.get("/api/admin/instances?page=2&page_size=1&sort=name&order=asc");
    expect(p2.body.data.instances[0].name).toBe("bob-db");

    expect((await admin.get("/api/admin/instances?page=0")).status).toBe(400);
    expect((await admin.get("/api/admin/instances?status=bogus")).status).toBe(400);
    expect((await admin.get("/api/admin/instances?sort=bogus")).status).toBe(400);
  });

  it("distinguishes missing containers from unreachable hosts", async () => {
    const db = (await import("../src/db.js")).getDb();
    // Detached record: verifiably missing, no host to ask.
    const detached = makeInstance(db, alice, { name: "detached", container_id: "detached", node_id: null });
    void detached;
    const admin = await login("admin@test.local", "AdminPass12345");

    const missing = await admin.get("/api/admin/instances?status=missing");
    expect(missing.status).toBe(200);
    expect(missing.body.data.instances.map((i: any) => i.name)).toEqual(["detached"]);
    expect(missing.body.data.instances[0].live.exists).toBe(false);

    // The node-attached rows cannot be inventoried on this box: unavailable, never "missing".
    const unavailable = await admin.get("/api/admin/instances?status=unavailable");
    expect(unavailable.status).toBe(200);
    const names = unavailable.body.data.instances.map((i: any) => i.name).sort();
    expect(names).toEqual(["alice-web", "bob-db"]);
    for (const inst of unavailable.body.data.instances) {
      expect(inst.live.exists).toBeNull();
      expect(typeof inst.live.error).toBe("string");
    }
  });

  it("reports recorded-status statistics honestly", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const res = await admin.get("/api/admin/instances/stats");
    expect(res.status).toBe(200);
    expect(res.body.data.stats).toMatchObject({
      total: 2,
      running: 1,
      stopped: 1,
      transitional: 0,
      failed: 0,
      unknown: 0,
      missing_owner: 0,
      missing_node: 0,
    });
  });

  it("returns full detail with owner, node, and live state", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const res = await admin.get(`/api/admin/instances/${aliceInstance}`);
    expect(res.status).toBe(200);
    expect(res.body.data.instance.id).toBe(aliceInstance);
    expect(res.body.data.instance.owner_id).toBe(alice);
    expect(res.body.data.owner.email).toBe("alice@test.local");
    expect(res.body.data.owner.password_hash).toBeUndefined();
    expect(res.body.data.node.id).toBe("local");
    expect(res.body.data.live.exists).toBeNull();
    expect((await admin.get("/api/admin/instances/vps_missing")).status).toBe(404);
  });

  it("transfers ownership to another active user and audits it", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const res = await admin.post(`/api/admin/instances/${aliceInstance}/transfer`).send({ target_user_id: bob });
    expect(res.status).toBe(200);
    expect(res.body.data.instance.owner_id).toBe(bob);
    expect(res.body.data.owner.email).toBe("bob@test.local");
    const db = (await import("../src/db.js")).getDb();
    const row = db.prepare("SELECT owner_id, container_id FROM instances WHERE id = ?").get(aliceInstance) as {
      owner_id: string;
      container_id: string;
    };
    // Ownership moved; the container reference is untouched.
    expect(row.owner_id).toBe(bob);
    expect(row.container_id).toBe("alice-web");
    const events = db
      .prepare("SELECT action, target_type, detail FROM audit_events WHERE target_id = ?").all(aliceInstance) as {
      action: string;
      target_type: string;
      detail: string;
    }[];
    const transfer = events.find((e) => e.action === "admin.instance_transfer");
    expect(transfer).toBeDefined();
    expect(transfer!.target_type).toBe("instance");
    const detail = JSON.parse(transfer!.detail) as { from: string; to: string };
    expect(detail).toEqual({ from: alice, to: bob });
    expect(transfer!.detail).not.toContain("Pass12345");
    // The list reflects the new owner immediately.
    const list = await admin.get(`/api/admin/instances?owner_id=${bob}`);
    expect(list.body.data.pagination.total).toBe(2);
  });

  it("rejects invalid transfers", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const missing = await admin.post(`/api/admin/instances/${aliceInstance}/transfer`).send({ target_user_id: "usr_nope" });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("TARGET_NOT_FOUND");

    const db = (await import("../src/db.js")).getDb();
    const disabled = await makeUser(db, { email: "zed@test.local", password: "ZedPass12345", name: "Zed", status: "disabled" });
    const toDisabled = await admin.post(`/api/admin/instances/${aliceInstance}/transfer`).send({ target_user_id: disabled });
    expect(toDisabled.status).toBe(409);
    expect(toDisabled.body.error.code).toBe("TARGET_DISABLED");

    const sameOwner = await admin.post(`/api/admin/instances/${aliceInstance}/transfer`).send({ target_user_id: alice });
    expect(sameOwner.status).toBe(400);

    const noTarget = await admin.post(`/api/admin/instances/${aliceInstance}/transfer`).send({});
    expect(noTarget.status).toBe(400);

    const noInstance = await admin.post("/api/admin/instances/vps_nope/transfer").send({ target_user_id: bob });
    expect(noInstance.status).toBe(404);

    // Nothing moved.
    const row = db.prepare("SELECT owner_id FROM instances WHERE id = ?").get(aliceInstance) as { owner_id: string };
    expect(row.owner_id).toBe(alice);
    expect(auditActions(db, aliceInstance)).not.toContain("admin.instance_transfer");
  });

  it("audits power attempts without faking state on failure", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const res = await admin.post(`/api/instances/${aliceInstance}/actions`).send({ action: "start" });
    // No LXC tooling on the test box: honest provider failure.
    expect(res.status).toBe(502);
    const db = (await import("../src/db.js")).getDb();
    const row = db.prepare("SELECT status FROM instances WHERE id = ?").get(aliceInstance) as { status: string };
    expect(row.status).toBe("stopped");
    const events = db
      .prepare("SELECT action, detail FROM audit_events WHERE target_id = ? AND action = 'instance.power'").all(aliceInstance) as {
      action: string;
      detail: string;
    }[];
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0].detail) as Record<string, unknown>;
    expect(detail.action).toBe("start");
    expect(detail.outcome).toBe("failed");
    expect(typeof detail.error).toBe("string");
  });

  it("keeps the user dashboard strictly owner-scoped", async () => {
    const bobAgent = await login("bob@test.local", "BobPass12345");
    const res = await bobAgent.get("/api/instances");
    expect(res.status).toBe(200);
    expect(res.body.data.instances.map((i: any) => i.name)).toEqual(["bob-db"]);
  });
});
