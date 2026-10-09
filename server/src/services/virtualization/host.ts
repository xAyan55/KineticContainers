import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { ProviderError, type ContainerInfo, type ContainerStatus } from "./provider.js";
import { nowIso } from "../../db.js";

const TIMEOUT_MS = 15000;
const MAX_OUTPUT = 64 * 1024;

/** Narrow command allowlist: only LXC tooling, invoked with fixed arg vectors. */
const LXC_ALLOWLIST = new Set([
  "lxc-ls",
  "lxc-info",
  "lxc-create",
  "lxc-start",
  "lxc-stop",
  "lxc-destroy",
  "lxc-checkconfig",
]);

function execFileStrict(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { killed?: boolean }).code;
          const killed = (err as { killed?: boolean }).killed === true;
          if (code === "ENOENT") {
            reject(new ProviderError("LXC_UNAVAILABLE", `Required tool is not installed: ${cmd}.`));
            return;
          }
          if (killed) {
            reject(new ProviderError("LXC_TIMEOUT", `Host command timed out: ${cmd}.`, 504));
            return;
          }
          reject(new ProviderError("LXC_COMMAND_FAILED", `Host command failed (${code ?? "error"}): ${cmd}.`));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

/** Run an LXC binary. The command must be allowlisted; args are never shelled. */
export function runLxc(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (!LXC_ALLOWLIST.has(cmd)) {
    return Promise.reject(new ProviderError("COMMAND_NOT_ALLOWED", `Command is not allowlisted: ${cmd}.`, 400));
  }
  return execFileStrict(cmd, args);
}

export function parseLxcLs(output: string): ContainerInfo[] {
  // `lxc-ls -f` output varies by distro; parse defensively.
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: ContainerInfo[] = [];
  for (const line of lines) {
    const parts = line.split(/[\s,]+/);
    if (parts.length === 0) continue;
    const name = (parts[0] ?? "").trim();
    if (!name || name.toUpperCase() === "NAME") continue;
    const rawState = (parts[1] ?? "").toLowerCase();
    let status: ContainerStatus = "unknown";
    if (rawState.includes("run")) status = "running";
    else if (rawState.includes("stop")) status = "stopped";
    else if (rawState.includes("frozen")) status = "stopped";
    const ipv4 = parts.find((p) => /^\d+\.\d+\.\d+\.\d+$/.test(p));
    out.push({ containerId: name, name, status, ipv4 });
  }
  return out;
}

export interface HostInfo {
  hostname: string;
  platform: string;
  osName: string | null;
  osVersion: string | null;
  kernel: string;
  arch: string;
  memoryTotalMb: number;
  memoryFreeMb: number;
  memoryUsedMb: number;
  cpuModel: string | null;
  cpuCount: number;
  cpuPercent: number | null;
  load1: number | null;
  rootTotalGb: number | null;
  rootUsedGb: number | null;
  rootAvailGb: number | null;
}

function readOsRelease(): { name: string | null; version: string | null } {
  try {
    const raw = fs.readFileSync("/etc/os-release", "utf8").slice(0, 4096);
    const pick = (key: string): string | null => {
      const m = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
      if (!m) return null;
      return m[1].trim().replace(/^"|"$/g, "").slice(0, 120) || null;
    };
    return { name: pick("NAME"), version: pick("VERSION") };
  } catch {
    return { name: null, version: null };
  }
}

function cpuSnapshot(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Short two-sample CPU busy percentage; null when it cannot be measured. */
export async function sampleCpuPercent(): Promise<number | null> {
  try {
    const a = cpuSnapshot();
    await new Promise((r) => setTimeout(r, 250));
    const b = cpuSnapshot();
    const totalDelta = b.total - a.total;
    const idleDelta = b.idle - a.idle;
    if (totalDelta <= 0) return null;
    const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
    return Math.round(pct * 10) / 10;
  } catch {
    return null;
  }
}

async function readRootFs(): Promise<{ totalGb: number; usedGb: number; availGb: number } | null> {
  try {
    // Fixed args, no user input: `df -P -B1 /`.
    const { stdout } = await execFileStrict("df", ["-P", "-B1", "/"]);
    const lines = stdout.trim().split("\n");
    const last = lines[lines.length - 1] ?? "";
    const parts = last.split(/\s+/);
    if (parts.length < 4) return null;
    const toGb = (v: string): number | null => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.round((n / 1024 ** 3) * 10) / 10;
    };
    const totalGb = toGb(parts[1]);
    const usedGb = toGb(parts[2]);
    const availGb = toGb(parts[3]);
    if (totalGb === null || usedGb === null || availGb === null) return null;
    return { totalGb, usedGb, availGb };
  } catch {
    return null;
  }
}

const MB = 1024 * 1024;

function emptyHostInfo(): HostInfo {
  return {
    hostname: "unknown",
    platform: "unknown",
    osName: null,
    osVersion: null,
    kernel: "unknown",
    arch: "unknown",
    memoryTotalMb: 0,
    memoryFreeMb: 0,
    memoryUsedMb: 0,
    cpuModel: null,
    cpuCount: 0,
    cpuPercent: null,
    load1: null,
    rootTotalGb: null,
    rootUsedGb: null,
    rootAvailGb: null,
  };
}

/** Best-effort host measurements. Never throws: unknowns stay null/zero. */
export async function getHostInfo(): Promise<HostInfo> {
  try {
    return await collectHostInfo();
  } catch {
    return emptyHostInfo();
  }
}

async function collectHostInfo(): Promise<HostInfo> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = (() => {
    try {
      return os.cpus();
    } catch {
      return [];
    }
  })();
  const release = readOsRelease();
  const root = await readRootFs();
  const load = (() => {
    try {
      const v = os.loadavg()[0];
      return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
    } catch {
      return null;
    }
  })();
  return {
    hostname: (() => {
      try {
        return os.hostname().slice(0, 255);
      } catch {
        return "unknown";
      }
    })(),
    platform: os.platform(),
    osName: release.name,
    osVersion: release.version,
    kernel: (() => {
      try {
        return os.release().slice(0, 120);
      } catch {
        return "unknown";
      }
    })(),
    arch: (() => {
      try {
        return os.arch();
      } catch {
        return "unknown";
      }
    })(),
    memoryTotalMb: Math.round(totalMem / MB),
    memoryFreeMb: Math.round(freeMem / MB),
    memoryUsedMb: Math.max(0, Math.round((totalMem - freeMem) / MB)),
    cpuModel: cpus[0]?.model?.slice(0, 160) ?? null,
    cpuCount: cpus.length,
    cpuPercent: await sampleCpuPercent(),
    load1: load,
    rootTotalGb: root?.totalGb ?? null,
    rootUsedGb: root?.usedGb ?? null,
    rootAvailGb: root?.availGb ?? null,
  };
}

export interface NodeHealthCheck {
  status: string;
  ok: boolean;
  checkedAt: string;
  detail: string;
  checks: {
    lxcInstalled: boolean;
    commandsOk: boolean;
    permissionsOk: boolean;
    inventoryOk: boolean;
    resourcesOk: boolean;
  };
  host: HostInfo | null;
  containersTotal: number | null;
  containersRunning: number | null;
}

export interface NodeContainer extends ContainerInfo {
  managed: boolean;
  owner: { id: string; name: string; email: string } | null;
}

interface NodeRow {
  id: string;
  name: string;
  endpoint: string;
  node_type: string;
  provider: string;
  is_protected: number;
}

function getNodeRow(db: Database.Database, id: string): NodeRow {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  if (!row) throw new ProviderError("NOT_FOUND", "Node not found.", 404);
  return row;
}

function persistHealth(
  db: Database.Database,
  nodeId: string,
  result: { status: string; ok: boolean; checkedAt: string; error: string | null; capabilities: string | null }
): void {
  const txn = db.transaction(() => {
    if (result.capabilities !== null) {
      db.prepare(
        "UPDATE nodes SET status = ?, last_check_at = ?, last_check_ok = ?, last_error = ?, capabilities = ?, updated_at = ? WHERE id = ?"
      ).run(result.status, result.checkedAt, result.ok ? 1 : 0, result.error, result.capabilities, result.checkedAt, nodeId);
    } else {
      // Preserve last-known-good inventory on failure; only the status changes.
      db.prepare(
        "UPDATE nodes SET status = ?, last_check_at = ?, last_check_ok = ?, last_error = ?, updated_at = ? WHERE id = ?"
      ).run(result.status, result.checkedAt, 0, result.error, result.checkedAt, nodeId);
    }
  });
  txn();
}

function permissionDenied(message: string): boolean {
  return /EACCES|EPERM|permission denied/i.test(message);
}

/**
 * Run a full health check for a node and persist the outcome.
 * Remote nodes honestly report 'unavailable': no remote agent exists.
 */
export async function checkNodeHealth(db: Database.Database, nodeId: string): Promise<NodeHealthCheck> {
  const checkedAt = nowIso();
  const node = getNodeRow(db, nodeId);

  if (node.endpoint !== "local") {
    const detail = "Remote node agent is not implemented; only the local host integration is supported.";
    persistHealth(db, nodeId, { status: "unavailable", ok: false, checkedAt, error: detail, capabilities: null });
    return {
      status: "unavailable",
      ok: false,
      checkedAt,
      detail,
      checks: { lxcInstalled: false, commandsOk: false, permissionsOk: false, inventoryOk: false, resourcesOk: false },
      host: null,
      containersTotal: null,
      containersRunning: null,
    };
  }

  try {
    const { stdout } = await runLxc("lxc-ls", ["-f"]);
    const containers = parseLxcLs(stdout);
    const host = await getHostInfo();
    const running = containers.filter((c) => c.status === "running").length;
    const resourcesOk =
      host.memoryTotalMb > 0 && (host.cpuCount > 0 || host.rootTotalGb !== null);
    const capabilities = JSON.stringify({
      containersTotal: containers.length,
      containersRunning: running,
      cpuPercent: host.cpuPercent,
      memoryUsedMb: host.memoryUsedMb,
      memoryTotalMb: host.memoryTotalMb,
      storageUsedGb: host.rootUsedGb,
      storageTotalGb: host.rootTotalGb,
      host: {
        hostname: host.hostname,
        platform: host.platform,
        osName: host.osName,
        osVersion: host.osVersion,
        kernel: host.kernel,
        arch: host.arch,
        cpuModel: host.cpuModel,
        cpuCount: host.cpuCount,
        load1: host.load1,
      },
    });
    persistHealth(db, nodeId, {
      status: "online",
      ok: true,
      checkedAt,
      error: null,
      capabilities,
    });
    return {
      status: "online",
      ok: true,
      checkedAt,
      detail: "Host agent reachable; LXC tools responded.",
      checks: { lxcInstalled: true, commandsOk: true, permissionsOk: true, inventoryOk: true, resourcesOk },
      host,
      containersTotal: containers.length,
      containersRunning: running,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Health check failed.";
    const code = err instanceof ProviderError ? err.code : "CHECK_FAILED";
    let status = "error";
    let detail = message;
    const checks = { lxcInstalled: true, commandsOk: false, permissionsOk: false, inventoryOk: false, resourcesOk: false };
    if (code === "LXC_UNAVAILABLE") {
      status = "unconfigured";
      detail = "LXC is not installed on this host. Install the LXC tooling to manage containers on the Local Node.";
      checks.lxcInstalled = false;
    } else if (code === "LXC_TIMEOUT") {
      detail = "The health check timed out waiting for the host integration.";
    } else if (permissionDenied(message)) {
      detail = "Permission denied: the backend cannot execute the LXC tooling. Run with sufficient privileges for container operations.";
    }
    persistHealth(db, nodeId, { status, ok: false, checkedAt, error: detail, capabilities: null });
    return { status, ok: false, checkedAt, detail, checks, host: null, containersTotal: null, containersRunning: null };
  }
}

/**
 * Live container inventory for a node with KineticCT ownership resolved.
 * Host-discovered containers with no instance record are reported as
 * unmanaged — never assigned to an arbitrary user.
 */
export async function getNodeContainers(
  db: Database.Database,
  nodeId: string
): Promise<{ nodeId: string; checkedAt: string; containers: NodeContainer[] }> {
  const node = getNodeRow(db, nodeId);
  if (node.endpoint !== "local") {
    throw new ProviderError("REMOTE_NODE_UNSUPPORTED", "Container inventory is only available for the local node.", 409);
  }
  const { stdout } = await runLxc("lxc-ls", ["-f"]);
  const live = parseLxcLs(stdout);
  const owned = db
    .prepare(
      `SELECT i.container_id AS container_id, u.id AS owner_id, u.name AS owner_name, u.email AS owner_email
       FROM instances i JOIN users u ON u.id = i.owner_id WHERE i.node_id = ?`
    )
    .all(nodeId) as { container_id: string; owner_id: string; owner_name: string; owner_email: string }[];
  const byContainer = new Map(owned.map((o) => [o.container_id, o]));
  return {
    nodeId,
    checkedAt: nowIso(),
    containers: live.map((c) => {
      const o = byContainer.get(c.containerId) ?? byContainer.get(c.name);
      return {
        ...c,
        managed: Boolean(o),
        owner: o ? { id: o.owner_id, name: o.owner_name, email: o.owner_email } : null,
      };
    }),
  };
}
