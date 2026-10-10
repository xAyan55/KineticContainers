import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { openTestDb, setDbForTests, newId, nowIso } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";
import {
  templateImage,
  downloadArch,
  buildCgroupConfig,
  parseEffectiveLimits,
  parseLxcInfo,
  parseLxcMetrics,
  applyResourceLimits,
  readEffectiveConfig,
} from "../src/services/virtualization/localAgent.js";
import { authorizeConsole, __setPtyForTests } from "../src/services/virtualization/console.js";
import { attachConsoleGateway } from "../src/services/virtualization/console.js";
import { ProviderError } from "../src/services/virtualization/provider.js";

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
    (overrides.container_id as string) ?? "web-01",
    (overrides.node_id as string | null) ?? "local",
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

describe("template and arch mapping", () => {
  it("maps every supported template to the correct image (no silent jammy)", () => {
    expect(templateImage("ubuntu-22.04")).toEqual({ distro: "ubuntu", release: "jammy" });
    expect(templateImage("ubuntu-24.04")).toEqual({ distro: "ubuntu", release: "noble" });
    expect(templateImage("debian-12")).toEqual({ distro: "debian", release: "bookworm" });
    expect(templateImage("alpine-3.20")).toEqual({ distro: "alpine", release: "3.20" });
  });

  it("rejects unknown templates", () => {
    expect(() => templateImage("windows-11")).toThrowError(ProviderError);
    try {
      templateImage("windows-11");
      expect.unreachable();
    } catch (err) {
      expect((err as ProviderError).code).toBe("UNSUPPORTED_TEMPLATE");
    }
  });

  it("maps host arch to download arch instead of forcing amd64", () => {
    expect(downloadArch("x64")).toBe("amd64");
    expect(downloadArch("arm64")).toBe("arm64");
    expect(() => downloadArch("ia32")).toThrowError(ProviderError);
  });
});

describe("cgroup resource config", () => {
  it("builds exact v1 hard-cap lines", () => {
    expect(buildCgroupConfig("v1", { cpu: 2, memoryMb: 2048 })).toEqual([
      "lxc.cgroup.cpu.cfs_period_us = 100000",
      "lxc.cgroup.cpu.cfs_quota_us = 200000",
      "lxc.cgroup.memory.limit_in_bytes = 2147483648",
    ]);
  });

  it("builds exact v2 hard-cap lines", () => {
    expect(buildCgroupConfig("v2", { cpu: 2, memoryMb: 2048 })).toEqual([
      "lxc.cgroup2.cpu.max = 200000 100000",
      "lxc.cgroup2.memory.max = 2147483648",
    ]);
  });

  it("round-trips limits through parse", () => {
    const v2 = buildCgroupConfig("v2", { cpu: 4, memoryMb: 4096 }).join("\n");
    expect(parseEffectiveLimits(`lxc.net.0.type = veth\n${v2}\n`, "v2")).toEqual({ cpu: 4, memoryMb: 4096 });
    const v1 = buildCgroupConfig("v1", { cpu: 1, memoryMb: 512 }).join("\n");
    expect(parseEffectiveLimits(v1, "v1")).toEqual({ cpu: 1, memoryMb: 512 });
    expect(parseEffectiveLimits("# empty config\n", "v2")).toEqual({ cpu: null, memoryMb: null });
  });

  it("writes and reads back real config files without touching other keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kct-lxc-"));
    const prevRoot = process.env.KCT_LXC_PATH;
    const prevCg = process.env.KCT_CGROUP_VERSION;
    process.env.KCT_LXC_PATH = dir;
    process.env.KCT_CGROUP_VERSION = "v2";
    try {
      fs.mkdirSync(path.join(dir, "web-01"), { recursive: true });
      const original = "#Template comment\nlxc.net.0.type = veth\nlxc.net.0.link = lxcbr0\n";
      fs.writeFileSync(path.join(dir, "web-01", "config"), original);
      const res = await applyResourceLimits("web-01", { cpu: 2, memoryMb: 1024 });
      expect(res.cgroupVersion).toBe("v2");
      const text = fs.readFileSync(path.join(dir, "web-01", "config"), "utf8");
      expect(text).toContain("lxc.net.0.type = veth");
      expect(text).toContain("lxc.cgroup2.cpu.max = 200000 100000");
      expect(text).toContain("lxc.cgroup2.memory.max = 1073741824");
      const read = await readEffectiveConfig("web-01");
      expect(read.cpu).toBe(2);
      expect(read.memoryMb).toBe(1024);
      expect(read.storageEnforced).toBe(false);
      // Re-apply must not duplicate keys.
      await applyResourceLimits("web-01", { cpu: 4, memoryMb: 2048 });
      const text2 = fs.readFileSync(path.join(dir, "web-01", "config"), "utf8");
      expect(text2.match(/lxc\.cgroup2\.cpu\.max/g)).toHaveLength(1);
      expect(text2).toContain("lxc.cgroup2.cpu.max = 400000 100000");
    } finally {
      if (prevRoot === undefined) delete process.env.KCT_LXC_PATH;
      else process.env.KCT_LXC_PATH = prevRoot;
      if (prevCg === undefined) delete process.env.KCT_CGROUP_VERSION;
      else process.env.KCT_CGROUP_VERSION = prevCg;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lxc-info parsing", () => {
  const SAMPLE = `Name:           web-01
State:          RUNNING
PID:            4242
IP:             10.0.3.15
IP:             fd42::10
Link:           vethABC123
 TX bytes:      1.2 KiB
Memory use:     96.5 MiB
CPU use:        12.34 seconds
`;

  it("extracts state, pid, addresses, and links without inventing any", () => {
    const n = parseLxcInfo(SAMPLE);
    expect(n.state).toBe("RUNNING");
    expect(n.pid).toBe(4242);
    expect(n.ipv4).toEqual(["10.0.3.15"]);
    expect(n.ipv6).toEqual(["fd42::10"]);
    expect(n.links).toEqual(["vethABC123"]);
  });

  it("handles stopped containers with no addresses", () => {
    const n = parseLxcInfo("Name: x\nState: STOPPED\n");
    expect(n.state).toBe("STOPPED");
    expect(n.ipv4).toEqual([]);
    expect(n.pid).toBeNull();
  });

  it("parses live metrics with unit conversion", () => {
    expect(parseLxcMetrics(SAMPLE)).toEqual({ cpuSeconds: 12.34, memoryMb: 96.5 });
    expect(parseLxcMetrics("Name: x\n")).toEqual({ cpuSeconds: null, memoryMb: null });
  });
});

describe("instance API honesty and isolation", () => {
  let app: ReturnType<typeof createApp>;
  let alice = "";
  let bob = "";
  let aliceInstance = "";

  beforeEach(async () => {
    const db = openTestDb();
    setDbForTests(db);
    vi.stubEnv("CORS_ORIGINS", "");
    __setPtyForTests(null);
    await makeUser(db, { email: "admin@test.local", password: "AdminPass12345", role: "admin", name: "Admin" });
    alice = await makeUser(db, { email: "alice@test.local", password: "AlicePass12345", name: "Alice" });
    bob = await makeUser(db, { email: "bob@test.local", password: "BobPass12345", name: "Bob" });
    aliceInstance = makeInstance(db, alice);
    app = createApp();
  });

  afterEach(() => {
    __setPtyForTests(undefined);
    vi.unstubAllEnvs();
  });

  async function login(email: string, password: string) {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email, password });
    return agent;
  }

  it("rejects cross-user access on every instance endpoint", async () => {
    const bobAgent = await login("bob@test.local", "BobPass12345");
    expect((await bobAgent.get(`/api/instances/${aliceInstance}`)).status).toBe(404);
    expect((await bobAgent.get(`/api/instances/${aliceInstance}/live`)).status).toBe(404);
    expect((await bobAgent.get(`/api/instances/${aliceInstance}/network`)).status).toBe(404);
    expect((await bobAgent.get(`/api/instances/${aliceInstance}/config`)).status).toBe(404);
    expect((await bobAgent.get(`/api/instances/${aliceInstance}/console`)).status).toBe(404);
    expect((await bobAgent.patch(`/api/instances/${aliceInstance}/resources`).send({ cpu: 4 })).status).toBe(404);
    expect((await bobAgent.patch(`/api/instances/${aliceInstance}`).send({ name: "hijacked" })).status).toBe(404);
    expect((await bobAgent.delete(`/api/instances/${aliceInstance}`)).status).toBe(404);
    expect((await bobAgent.post(`/api/instances/${aliceInstance}/actions`).send({ action: "start" })).status).toBe(404);
    // Untouched by all of the above.
    const db = (await import("../src/db.js")).getDb();
    const row = db.prepare("SELECT name, cpu FROM instances WHERE id = ?").get(aliceInstance) as {
      name: string;
      cpu: number;
    };
    expect(row.name).toBe("web-01");
    expect(row.cpu).toBe(2);
  });

  it("reports failed actions honestly without faking DB state", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    // No LXC tooling on the test box: the operation must fail with a real
    // provider error and leave the stored status exactly as it was.
    const res = await aliceAgent.post(`/api/instances/${aliceInstance}/actions`).send({ action: "start" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("LXC_UNAVAILABLE");
    const db = (await import("../src/db.js")).getDb();
    const row = db.prepare("SELECT status FROM instances WHERE id = ?").get(aliceInstance) as { status: string };
    expect(row.status).toBe("stopped");
  });

  it("reports missing containers instead of stale running state", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    const res = await aliceAgent.get(`/api/instances/${aliceInstance}`);
    expect(res.status).toBe(200);
    // LXC tooling absent: live state is unknown, never presented as fact.
    expect(res.body.data.live.exists).toBeNull();
    expect(typeof res.body.data.live.error).toBe("string");
  });

  it("refuses disk quota changes honestly", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    const res = await aliceAgent.patch(`/api/instances/${aliceInstance}/resources`).send({ storage_gb: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("STORAGE_IMMUTABLE");
  });

  it("validates resource updates before touching the host", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    expect((await aliceAgent.patch(`/api/instances/${aliceInstance}/resources`).send({})).status).toBe(400);
    expect((await aliceAgent.patch(`/api/instances/${aliceInstance}/resources`).send({ cpu: 99 })).status).toBe(400);
    expect((await aliceAgent.patch(`/api/instances/${aliceInstance}/resources`).send({ memory_mb: 1 })).status).toBe(400);
  });

  it("renames the display name without touching anything else", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    const res = await aliceAgent.patch(`/api/instances/${aliceInstance}`).send({ name: "renamed-box" });
    expect(res.status).toBe(200);
    expect(res.body.data.instance.name).toBe("renamed-box");
    expect(res.body.data.instance.container_id).toBe("web-01");
  });

  it("rejects console access without a session", async () => {
    expect((await request(app).get(`/api/instances/${aliceInstance}/console`)).status).toBe(401);
  });

  it("reports console unavailable instead of a fake terminal", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    const res = await aliceAgent.get(`/api/instances/${aliceInstance}/console`);
    expect(res.status).toBe(200);
    expect(res.body.data.supported).toBe(false);
    expect(typeof res.body.data.reason).toBe("string");
  });

  it("authorizeConsole rejects anonymous and cross-user attempts", async () => {
    await expect(authorizeConsole(undefined, aliceInstance)).rejects.toMatchObject({ status: 401 });
    // Build a real session cookie for bob and try alice's instance with it.
    const raw = await request(app).post("/api/auth/login").send({ email: "bob@test.local", password: "BobPass12345" });
    const setCookie = raw.headers["set-cookie"] as unknown as string[];
    const header = Array.isArray(setCookie) ? setCookie.join("; ") : "";
    await expect(authorizeConsole(header, aliceInstance)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses unauthenticated websocket upgrades", async () => {
    const srv = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => srv.once("listening", resolve));
    const { port } = srv.address() as AddressInfo;
    attachConsoleGateway(srv);
    const outcome = await new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/instances/${aliceInstance}/console`);
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        resolve({ code: -2 });
      }, 8000);
      ws.on("close", (code: number) => {
        clearTimeout(timer);
        resolve({ code });
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve({ code: -1 });
      });
    });
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    expect([4401, -1]).toContain(outcome.code);
  });

  it("does not insert records for invalid creation requests", async () => {
    const admin = await login("admin@test.local", "AdminPass12345");
    const users = await admin.get("/api/admin/users");
    const owner = users.body.data.users.find((u: { email: string }) => u.email === "alice@test.local").id;
    const before = (
      (await import("../src/db.js")).getDb().prepare("SELECT COUNT(*) AS n FROM instances").get() as { n: number }
    ).n;
    const res = await admin.post("/api/admin/instances").send({
      name: "bad-01",
      node_id: "local",
      owner_id: owner,
      template: "windows-11",
      cpu: 1,
      memory_mb: 512,
      storage_gb: 10,
    });
    expect(res.status).toBe(400);
    const after = (
      (await import("../src/db.js")).getDb().prepare("SELECT COUNT(*) AS n FROM instances").get() as { n: number }
    ).n;
    expect(after).toBe(before);
  });
});
