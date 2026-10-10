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
  parseCpusetCount,
  parseEffectiveLimits,
  parseLxcInfo,
  parseLxcMetrics,
  parseDfFstype,
  parseBtrfsSubvolId,
  parseBtrfsQgroupLimit,
  parseRepquotaProject,
  parseTune2fsQuotaFeatures,
  parseMountOptions,
  deriveProjectId,
  gbToQuotaBlocks,
  sanitizeMetric,
  lxcfsIncludePresent,
  applyResourceLimits,
  readEffectiveConfig,
  planInstanceRepair,
  checkHostCapacity,
  RESOURCE_MODEL,
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
  it("builds exact v1 hard-cap lines with a shared affinity set", () => {
    expect(buildCgroupConfig("v1", { cpu: 2, memoryMb: 2048 }, 8)).toEqual([
      "lxc.cgroup.cpu.cfs_period_us = 100000",
      "lxc.cgroup.cpu.cfs_quota_us = 200000",
      "lxc.cgroup.memory.limit_in_bytes = 2147483648",
      "lxc.cgroup.cpuset.cpus = 0-1",
    ]);
  });

  it("builds exact v2 hard-cap lines with a shared affinity set", () => {
    expect(buildCgroupConfig("v2", { cpu: 2, memoryMb: 2048 }, 8)).toEqual([
      "lxc.cgroup2.cpu.max = 200000 100000",
      "lxc.cgroup2.memory.max = 2147483648",
      "lxc.cgroup2.cpuset.cpus = 0-1",
    ]);
  });

  it("clamps the affinity set to the host and never claims dedication", () => {
    expect(buildCgroupConfig("v2", { cpu: 1, memoryMb: 512 }, 8)).toContain("lxc.cgroup2.cpuset.cpus = 0");
    // 32 vCPU requested on a 4-CPU host: quota stays honest, set spans the host.
    expect(buildCgroupConfig("v2", { cpu: 32, memoryMb: 512 }, 4)).toContain("lxc.cgroup2.cpuset.cpus = 0-3");
    // Unknown host CPU count: quota/memory still enforced, no invented cpuset.
    expect(buildCgroupConfig("v2", { cpu: 2, memoryMb: 512 }, 0)).toHaveLength(2);
    expect(RESOURCE_MODEL).toMatch(/never exclusively reserved/);
  });

  it("round-trips limits through parse", () => {
    const v2 = buildCgroupConfig("v2", { cpu: 4, memoryMb: 4096 }, 8).join("\n");
    expect(parseEffectiveLimits(`lxc.net.0.type = veth\n${v2}\n`, "v2")).toEqual({
      cpu: 4,
      memoryMb: 4096,
      cpuset: "0-3",
      cpusetCpus: 4,
    });
    const v1 = buildCgroupConfig("v1", { cpu: 1, memoryMb: 512 }, 8).join("\n");
    expect(parseEffectiveLimits(v1, "v1")).toEqual({ cpu: 1, memoryMb: 512, cpuset: "0", cpusetCpus: 1 });
    expect(parseEffectiveLimits("# empty config\n", "v2")).toEqual({ cpu: null, memoryMb: null, cpuset: null, cpusetCpus: null });
  });

  it("counts cpuset specs without inventing counts", () => {
    expect(parseCpusetCount("0-3")).toBe(4);
    expect(parseCpusetCount("0,2")).toBe(2);
    expect(parseCpusetCount("0")).toBe(1);
    expect(parseCpusetCount("0-1,3,5-6")).toBe(5);
    expect(parseCpusetCount(null)).toBeNull();
    expect(parseCpusetCount("")).toBeNull();
    expect(parseCpusetCount("abc")).toBeNull();
    expect(parseCpusetCount("3-1")).toBeNull();
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

  it("never echoes absurd metric values (regression: billion-GiB garbage)", () => {
    // Values resembling unlimited-cgroup artifacts must not survive.
    expect(sanitizeMetric(2915679709.81 * 1024, 32768)).toBeNull();
    expect(sanitizeMetric(Number.MAX_SAFE_INTEGER, 32768)).toBeNull();
    expect(sanitizeMetric(-5, 32768)).toBeNull();
    expect(sanitizeMetric(NaN, 32768)).toBeNull();
    expect(sanitizeMetric(Infinity, null)).toBeNull();
    expect(sanitizeMetric(null, 32768)).toBeNull();
    // Sane values pass through untouched, including exact-boundary ones.
    expect(sanitizeMetric(96.5, 32768)).toBe(96.5);
    expect(sanitizeMetric(32768, 32768)).toBe(32768);
    expect(sanitizeMetric(0, 32768)).toBe(0);
    // Without a known ceiling only finiteness/sign are enforced.
    expect(sanitizeMetric(123.4, null)).toBe(123.4);
  });
});

describe("storage backend detection", () => {
  const DF_BTRFS = `Filesystem     Type 1024-blocks      Used Available Capacity Mounted on
/dev/sda1      btrfs  104857600  20971520  83886080      20% /var/lib/lxc
`;
  const DF_EXT4 = `Filesystem     Type 1024-blocks      Used Available Capacity Mounted on
/dev/sda1      ext4  104857600  20971520  83886080      20% /
`;

  it("reads the filesystem type from df output", () => {
    expect(parseDfFstype(DF_BTRFS, "/var/lib/lxc")).toBe("btrfs");
    expect(parseDfFstype(DF_EXT4, "/")).toBe("ext4");
    expect(parseDfFstype("", "/")).toBeNull();
    expect(parseDfFstype("Filesystem\n", "/")).toBeNull();
  });

  it("extracts btrfs subvolume ids", () => {
    expect(parseBtrfsSubvolId("UUID: abc\nSubvolume ID: 257\n")).toBe("257");
    expect(parseBtrfsSubvolId("no id here\n")).toBeNull();
  });

  it("reads btrfs qgroup limits and rejects unlimited/garbage", () => {
    const out = `qgroupid         rfer         excl     max_rfer     max_excl
--------         ----         ----     --------     --------
0/257        1.00GiB      1.00GiB    20.00GiB         none
0/258        2.00GiB      2.00GiB         none         none
`;
    // Numeric byte limits are returned; "none" (unlimited) is not a capacity.
    expect(parseBtrfsQgroupLimit("qgroupid rfer excl max_rfer max_excl\n0/257 100 100 21474836480 0\n", "0/257")).toBe(
      21474836480
    );
    expect(parseBtrfsQgroupLimit(out, "0/258")).toBeNull();
    expect(parseBtrfsQgroupLimit(out, "0/999")).toBeNull();
    expect(parseBtrfsQgroupLimit("garbage\n", "0/257")).toBeNull();
  });
});

describe("ext4 project quotas", () => {
  const REPQUOTA = `*** Report for project quotas on device /dev/sda1
Block grace time: 7days; Inode grace time: 7days
                        Space limits                File limits
Project         used    soft    hard  grace    used  soft  hard grace
----------------------------------------------------------------------
#0        --  123456       0       0              10     0     0
#100042   --    1024 10485760 20971520              5     0     0
#100043   --       0       0       0              0     0     0
`;

  it("reads project quota rows and rejects unlimited/garbage", () => {
    expect(parseRepquotaProject(REPQUOTA, 100042)).toEqual({ usedKb: 1024, softKb: 10485760, hardKb: 20971520 });
    expect(parseRepquotaProject(REPQUOTA, 100043)).toEqual({ usedKb: 0, softKb: 0, hardKb: 0 });
    expect(parseRepquotaProject(REPQUOTA, 999999)).toBeNull();
    expect(parseRepquotaProject("garbage\n", 100042)).toBeNull();
    expect(parseRepquotaProject("", 100042)).toBeNull();
  });

  it("detects the quota filesystem feature", () => {
    expect(parseTune2fsQuotaFeatures("Filesystem features: has_journal ext_attr quota\n")).toBe(true);
    expect(parseTune2fsQuotaFeatures("Filesystem features: has_journal ext_attr\n")).toBe(false);
    expect(parseTune2fsQuotaFeatures("no features line\n")).toBe(false);
    expect(parseTune2fsQuotaFeatures("")).toBe(false);
  });

  it("reads mount options for an exact mountpoint only", () => {
    const mounts = "/dev/sda1 / ext4 rw,relatime,errors=remount-ro 0 1\n/dev/sda1 /var/lib/lxc ext4 rw,relatime,prjquota 0 0\n";
    expect(parseMountOptions(mounts, "/var/lib/lxc")).toEqual(["rw", "relatime", "prjquota"]);
    expect(parseMountOptions(mounts, "/")).toEqual(["rw", "relatime", "errors=remount-ro"]);
    expect(parseMountOptions(mounts, "/var/lib/lxcfoo")).toBeNull();
    expect(parseMountOptions(mounts, "/missing")).toBeNull();
    expect(parseMountOptions("", "/")).toBeNull();
  });

  it("derives deterministic collision-free project ids in range", () => {
    const a = deriveProjectId("web-01", []);
    const b = deriveProjectId("web-01", []);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(100000);
    expect(a).toBeLessThan(150000);
    expect(deriveProjectId("web-02", [a])).not.toBe(a);
    // Full circle still terminates inside the range.
    const taken = Array.from({ length: 49999 }, (_, i) => 100000 + i);
    const last = deriveProjectId("zzz", taken);
    expect(last).toBeGreaterThanOrEqual(100000);
    expect(last).toBeLessThan(150000);
  });

  it("converts GB to quota blocks and validates range", () => {
    expect(gbToQuotaBlocks(20)).toBe(20 * 1024 * 1024);
    expect(gbToQuotaBlocks(1)).toBe(1024 * 1024);
    expect(() => gbToQuotaBlocks(0)).toThrowError(ProviderError);
    expect(() => gbToQuotaBlocks(2001)).toThrowError(ProviderError);
    expect(() => gbToQuotaBlocks(1.5)).toThrowError(ProviderError);
  });
});

describe("host capacity admission", () => {
  it("refuses requests that provably exceed free capacity", () => {
    expect(() =>
      checkHostCapacity({ memoryTotalMb: 8192, memoryFreeMb: 100, diskAvailGb: 50 }, { memoryMb: 99999, storageGb: 10 })
    ).toThrowError(/only 100 MB free/);
    expect(() =>
      checkHostCapacity({ memoryTotalMb: 8192, memoryFreeMb: 8000, diskAvailGb: 5 }, { memoryMb: 512, storageGb: 20 })
    ).toThrowError(/only 5 GB free/);
    try {
      checkHostCapacity({ memoryTotalMb: 8192, memoryFreeMb: 100, diskAvailGb: 50 }, { memoryMb: 99999, storageGb: 10 });
      expect.unreachable();
    } catch (err) {
      expect((err as ProviderError).code).toBe("INSUFFICIENT_CAPACITY");
    }
  });

  it("passes when capacity suffices or is unknown", () => {
    expect(() =>
      checkHostCapacity({ memoryTotalMb: 8192, memoryFreeMb: 8000, diskAvailGb: 50 }, { memoryMb: 512, storageGb: 10 })
    ).not.toThrow();
    // Unknown readings never block provisioning.
    expect(() =>
      checkHostCapacity({ memoryTotalMb: 0, memoryFreeMb: 0, diskAvailGb: null }, { memoryMb: 512, storageGb: 10 })
    ).not.toThrow();
  });
});

describe("repair planning", () => {
  it("reports a missing container without touching anything", async () => {
    const plan = await planInstanceRepair("definitely-not-a-real-container", { cpu: 2, memoryMb: 1024, storageGb: 20 });
    expect(plan.exists).toBe(false);
    expect(plan.checks).toHaveLength(1);
  });
});

describe("LXCFS include handling", () => {
  it("detects the integration line exactly", () => {
    expect(
      lxcfsIncludePresent("lxc.include = /usr/share/lxc/config/common.conf.d/00-lxcfs.conf\n")
    ).toBe(true);
    expect(lxcfsIncludePresent("# lxc.include = /usr/share/lxc/config/common.conf.d/00-lxcfs.conf\n")).toBe(false);
    expect(lxcfsIncludePresent("lxc.include = /usr/share/lxc/config/common.conf\n")).toBe(false);
    expect(lxcfsIncludePresent("")).toBe(false);
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

  it("rejects repair access across users and without a session", async () => {
    const bobAgent = await login("bob@test.local", "BobPass12345");
    expect((await bobAgent.get(`/api/instances/${aliceInstance}/repair`)).status).toBe(404);
    expect((await bobAgent.post(`/api/instances/${aliceInstance}/repair`).send({})).status).toBe(404);
    expect((await request(app).get(`/api/instances/${aliceInstance}/repair`)).status).toBe(401);
    expect((await request(app).post(`/api/instances/${aliceInstance}/repair`).send({})).status).toBe(401);
  });

  it("reports an honest repair plan for a missing container", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    // No LXC tooling on the test box: the container cannot exist on any host.
    const plan = await aliceAgent.get(`/api/instances/${aliceInstance}/repair`);
    expect(plan.status).toBe(200);
    expect(plan.body.data.plan.exists).toBe(false);
    const applied = await aliceAgent.post(`/api/instances/${aliceInstance}/repair`).send({});
    expect(applied.status).toBe(200);
    expect(applied.body.data.report.checks[0].status).toBe("failed");
    // Nothing was modified: no backup, no drift.
    const db = (await import("../src/db.js")).getDb();
    const row = db.prepare("SELECT cpu, memory_mb FROM instances WHERE id = ?").get(aliceInstance) as {
      cpu: number;
      memory_mb: number;
    };
    expect(row.cpu).toBe(2);
    expect(row.memory_mb).toBe(2048);
    expect(applied.body.data.report.backupPath).toBeNull();
  });

  it("reports storage facts honestly when the backend is unreadable", async () => {
    const aliceAgent = await login("alice@test.local", "AlicePass12345");
    const res = await aliceAgent.get(`/api/instances/${aliceInstance}/config`);
    // No container tooling on the test box: config read fails honestly.
    expect([200, 404, 502]).toContain(res.status);
    if (res.status === 200) {
      expect(typeof res.body.data.effective.storageEnforced).toBe("boolean");
      expect(typeof res.body.data.effective.storageNote).toBe("string");
    }
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
    expect(res.body.data.reason).toContain("node-pty");
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
