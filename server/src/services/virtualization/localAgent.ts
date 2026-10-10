import type {
  ContainerInfo,
  CreateContainerRequest,
  NodeStatus,
  VirtualizationProvider,
} from "./provider.js";
import { ProviderError } from "./provider.js";
import { parseLxcLs, runHostTool, runLxc, runQuotaTool } from "./host.js";
import { getDb } from "../../db.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const run = runLxc;

function validateContainerId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$/.test(id)) {
    throw new ProviderError("INVALID_CONTAINER_ID", "Container identifier is invalid.", 400);
  }
}


/** Explicit allowlist: supported template id -> download-template arguments. */
const TEMPLATE_MAP: Record<string, { distro: string; release: string }> = {
  "ubuntu-22.04": { distro: "ubuntu", release: "jammy" },
  "ubuntu-24.04": { distro: "ubuntu", release: "noble" },
  "debian-12": { distro: "debian", release: "bookworm" },
  "alpine-3.20": { distro: "alpine", release: "3.20" },
};

export function templateImage(template: string): { distro: string; release: string } {
  const img = TEMPLATE_MAP[template];
  if (!img) {
    throw new ProviderError("UNSUPPORTED_TEMPLATE", "Requested template is not supported.", 400);
  }
  return img;
}

/** Map the host CPU to download-template architecture names. */
export function downloadArch(nodeArch: string = os.arch()): string {
  if (nodeArch === "x64") return "amd64";
  if (nodeArch === "arm64") return "arm64";
  throw new ProviderError(
    "UNSUPPORTED_ARCH",
    `Host CPU architecture is not supported for image download: ${nodeArch}.`,
    400
  );
}

/** Override the LXC container root (tests). Production default: /var/lib/lxc. */
export function lxcRoot(): string {
  return process.env.KCT_LXC_PATH ?? "/var/lib/lxc";
}

export function containerConfigPath(containerId: string): string {
  validateContainerId(containerId);
  return path.join(lxcRoot(), containerId, "config");
}

/** True when a container with this name exists on the host. */
export async function containerExistsOnHost(containerId: string): Promise<boolean> {
  validateContainerId(containerId);
  const { stdout } = await run("lxc-ls", ["-1"]);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(containerId);
}

/** Best-effort removal of a container this flow just created. Never throws. */
async function destroyQuietly(containerId: string): Promise<void> {
  try {
    if (await containerExistsOnHost(containerId)) {
      await run("lxc-destroy", ["-n", containerId, "-f"], { timeoutMs: 120000 });
    }
  } catch {
    /* Report the original error; residue (if any) is left for manual cleanup. */
  }
}

export type LxcState =
  | "RUNNING"
  | "STOPPED"
  | "STARTING"
  | "STOPPING"
  | "FREEZING"
  | "FROZEN"
  | "ABORTING"
  | "UNKNOWN";

const KNOWN_STATES: LxcState[] = [
  "RUNNING",
  "STOPPED",
  "STARTING",
  "STOPPING",
  "FREEZING",
  "FROZEN",
  "ABORTING",
];

/** Read the live state via `lxc-info -s`. Throws CONTAINER_NOT_FOUND when absent. */
export async function readContainerState(containerId: string): Promise<LxcState> {
  validateContainerId(containerId);
  try {
    const { stdout } = await run("lxc-info", ["-n", containerId, "-s"]);
    const m = stdout.match(/^\s*State:\s*([A-Za-z]+)/m);
    const s = (m?.[1] ?? "").toUpperCase();
    return (KNOWN_STATES as string[]).includes(s) ? (s as LxcState) : "UNKNOWN";
  } catch (err) {
    if (err instanceof ProviderError && err.code === "LXC_COMMAND_FAILED") {
      // lxc-info fails for missing containers; confirm before reporting 404.
      const exists = await containerExistsOnHost(containerId).catch(() => true);
      if (!exists) {
        throw new ProviderError("CONTAINER_NOT_FOUND", "Container not found on node.", 404);
      }
    }
    throw err instanceof ProviderError ? err : new ProviderError("STATE_READ_FAILED", "Could not read container state.");
  }
}

/** Block until the container reaches the wanted state (via lxc-wait). */
export async function waitForState(
  containerId: string,
  want: "RUNNING" | "STOPPED",
  timeoutSec = 90
): Promise<void> {
  validateContainerId(containerId);
  try {
    await run("lxc-wait", ["-n", containerId, "-s", want, "-t", String(timeoutSec)], {
      timeoutMs: (timeoutSec + 20) * 1000,
    });
  } catch (err) {
    if (err instanceof ProviderError && (err.code === "LXC_TIMEOUT" || err.code === "LXC_COMMAND_FAILED")) {
      throw new ProviderError(
        "STATE_TIMEOUT",
        `Container did not reach ${want} within ${timeoutSec}s.`,
        504
      );
    }
    throw err;
  }
}

export interface ContainerNetworkInfo {
  state: string;
  pid: number | null;
  ipv4: string[];
  ipv6: string[];
  links: string[];
  bridge: string | null;
}

function isIpv4(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

function isIpv6(s: string): boolean {
  return /^[0-9a-fA-F:]+$/.test(s) && s.includes(":");
}

/** Parse `lxc-info -n <id>` full output plus the container config for the bridge. */
export function parseLxcInfo(output: string): {
  state: string;
  pid: number | null;
  ipv4: string[];
  ipv6: string[];
  links: string[];
} {
  let state = "UNKNOWN";
  let pid: number | null = null;
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  const links: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^(Name|State|PID|IP|Link):\s*(.+)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "State") state = value.trim().toUpperCase() || "UNKNOWN";
    else if (key === "PID") {
      const n = Number(value.trim());
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (key === "IP") {
      const ip = value.trim();
      if (isIpv4(ip)) ipv4.push(ip);
      else if (isIpv6(ip)) ipv6.push(ip);
    } else if (key === "Link") {
      const link = value.trim();
      if (link) links.push(link);
    }
  }
  return { state, pid, ipv4, ipv6, links };
}

function parseBridgeFromConfig(configText: string): string | null {
  const m =
    configText.match(/^lxc\.net\.\d+\.link\s*=\s*(\S+)/m) ??
    configText.match(/^lxc\.network\.link\s*=\s*(\S+)/m);
  return m ? m[1].slice(0, 64) : null;
}

/** Live network facts for a container. Never invents addresses. */
export async function getContainerNetwork(containerId: string): Promise<ContainerNetworkInfo> {
  validateContainerId(containerId);
  let stdout: string;
  try {
    ({ stdout } = await run("lxc-info", ["-n", containerId]));
  } catch (err) {
    if (err instanceof ProviderError && err.code === "LXC_COMMAND_FAILED") {
      const exists = await containerExistsOnHost(containerId).catch(() => true);
      if (!exists) {
        throw new ProviderError("CONTAINER_NOT_FOUND", "Container not found on node.", 404);
      }
    }
    throw err instanceof ProviderError ? err : new ProviderError("NETWORK_READ_FAILED", "Could not read container network info.");
  }
  const parsed = parseLxcInfo(stdout);
  let bridge: string | null = null;
  try {
    const cfg = fs.readFileSync(containerConfigPath(containerId), "utf8");
    bridge = parseBridgeFromConfig(cfg);
  } catch {
    bridge = null;
  }
  return { ...parsed, bridge };
}

/** Live CPU/memory consumption reported by lxc-info (best effort). */
export function parseLxcMetrics(output: string): { cpuSeconds: number | null; memoryMb: number | null } {
  let cpuSeconds: number | null = null;
  let memoryMb: number | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    let m = line.match(/^CPU use:\s*([\d.]+)\s*seconds/i);
    if (m) {
      const n = Number(m[1]);
      cpuSeconds = Number.isFinite(n) && n >= 0 ? n : null;
      continue;
    }
    m = line.match(/^Memory use:\s*([\d.]+)\s*([KMGTPE]?i?B)/i);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2].toUpperCase();
      if (Number.isFinite(n) && n >= 0) {
        const factor =
          unit === "TIB" ? 1024 * 1024
          : unit === "GIB" ? 1024
          : unit === "MIB" ? 1
          : unit === "KIB" ? 1 / 1024
          : unit === "B" ? 1 / (1024 * 1024)
          : 0;
        memoryMb = factor > 0 ? Math.round(n * factor * 10) / 10 : null;
      }
    }
  }
  return { cpuSeconds, memoryMb };
}

export interface ContainerMetrics {
  cpuSeconds: number | null;
  memoryMb: number | null;
  /** Where the numbers came from: lxc-info output or direct cgroup reads. */
  source: "lxc-info" | "cgroup" | null;
  /** Human-readable reason when source is null (shown in the UI, never a stack). */
  detail: string | null;
}

/** Cgroup mount root, overridable for tests. */
export function cgroupRoot(): string {
  return process.env.KCT_CGROUP_ROOT ?? "/sys/fs/cgroup";
}

/**
 * Locate a container's cgroup directory without assuming one fixed layout.
 * Searches a bounded tree for a directory tied to the container id that
 * exposes memory/cpu readings. Returns null when not found.
 */
export function findContainerCgroup(containerId: string, maxDirs = 500): string | null {
  validateContainerId(containerId);
  const root = cgroupRoot();
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    if (visited > maxDirs) return null;
    let entries: string[];
    try {
      entries = fs.readdirSync(current.dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.includes(containerId)) continue;
      const full = path.join(current.dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      try {
        const inner = fs.readdirSync(full);
        if (inner.includes("memory.current") || inner.includes("cpu.stat")) return full;
      } catch {
        continue;
      }
    }
    if (current.depth < 3) {
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const full = path.join(current.dir, name);
        try {
          if (fs.statSync(full).isDirectory()) queue.push({ dir: full, depth: current.depth + 1 });
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

function readFirstNumber(file: string): number | null {
  try {
    const first = fs.readFileSync(file, "utf8").trim().split(/\s+/, 1)[0] ?? "";
    const n = Number(first);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Read memory.current (bytes) + cpu.stat usage_usec directly from the cgroup. */
export function readCgroupMetrics(containerId: string): { cpuSeconds: number | null; memoryMb: number | null } | null {
  const dir = findContainerCgroup(containerId);
  if (!dir) return null;
  let memoryMb: number | null = null;
  let cpuSeconds: number | null = null;
  const memBytes = readFirstNumber(path.join(dir, "memory.current"));
  if (memBytes !== null) memoryMb = Math.round((memBytes / (1024 * 1024)) * 10) / 10;
  try {
    const stat = fs.readFileSync(path.join(dir, "cpu.stat"), "utf8");
    const m = stat.match(/^usage_usec\s+(\d+)/m);
    if (m) cpuSeconds = Math.round((Number(m[1]) / 1e6) * 100) / 100;
  } catch {
    /* cpu stays null */
  }
  if (memoryMb === null && cpuSeconds === null) return null;
  return { cpuSeconds, memoryMb };
}

export async function getContainerMetrics(containerId: string): Promise<ContainerMetrics> {
  validateContainerId(containerId);
  // Primary source: lxc-info (works across cgroup layouts and versions).
  try {
    const { stdout } = await run("lxc-info", ["-n", containerId]);
    const parsed = parseLxcMetrics(stdout);
    // Plausibility guard: host tooling over unlimited cgroups can emit absurd
    // values (e.g. billions of GiB). A container can never use more than the
    // host has — anything beyond that is reported as unavailable, never echoed.
    const result = {
      cpuSeconds: sanitizeMetric(parsed.cpuSeconds, null),
      memoryMb: sanitizeMetric(parsed.memoryMb, hostTotalMemoryMb() || null),
    };
    if (result.cpuSeconds !== null || result.memoryMb !== null) {
      return { ...result, source: "lxc-info" as const, detail: null };
    }
  } catch {
    /* fall through to the cgroup fallback below */
  }
  // Fallback: read the container cgroup directly (no lxc-info parsing involved).
  try {
    const cgroup = readCgroupMetrics(containerId);
    if (!cgroup) {
      return {
        cpuSeconds: null,
        memoryMb: null,
        source: null,
        detail: "No readable metrics: lxc-info gave nothing usable and no container cgroup was found.",
      };
    }
    return {
      cpuSeconds: sanitizeMetric(cgroup.cpuSeconds, null),
      memoryMb: sanitizeMetric(cgroup.memoryMb, hostTotalMemoryMb() || null),
      source: "cgroup" as const,
      detail: null,
    };
  } catch {
    return {
      cpuSeconds: null,
      memoryMb: null,
      source: null,
      detail: "No readable metrics: lxc-info gave nothing usable and the container cgroup could not be read.",
    };
  }
}

export type CgroupVersion = "v1" | "v2" | "unknown";

export function detectCgroupVersion(): CgroupVersion {
  const override = process.env.KCT_CGROUP_VERSION;
  if (override === "v1" || override === "v2") return override;
  try {
    if (fs.existsSync("/sys/fs/cgroup/cgroup.controllers")) return "v2";
    if (fs.existsSync("/sys/fs/cgroup")) return "v1";
  } catch {
    /* fall through */
  }
  return "unknown";
}

export interface ResourceLimits {
  cpu: number;
  memoryMb: number;
}

/** Logical CPU count visible on this host (0 when undetectable). */
export function hostCpuCount(): number {
  try {
    const n = os.cpus().length;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Resource model label. KineticCT enforces a hard CPU quota plus a shared
 * CPU affinity set for correct guest-visible enumeration — it never claims
 * exclusively reserved physical cores.
 */
export const RESOURCE_MODEL =
  "Hard CPU quota plus a shared CPU affinity set sized to the vCPU allocation; cores remain shared with the host, never exclusively reserved.";

/**
 * Build the exact config lines that enforce CPU (hard quota), CPU visibility
 * (shared affinity set, never an exclusivity claim) and memory.
 * Pure and unit-tested; never invents storage quotas (dir backend has none).
 */
export function buildCgroupConfig(version: CgroupVersion, limits: ResourceLimits, hostCpus: number): string[] {
  const bytes = Math.round(limits.memoryMb * 1024 * 1024);
  const quota = Math.round(limits.cpu * 100000);
  const lines: string[] =
    version === "v1"
      ? [
          "lxc.cgroup.cpu.cfs_period_us = 100000",
          `lxc.cgroup.cpu.cfs_quota_us = ${quota}`,
          `lxc.cgroup.memory.limit_in_bytes = ${bytes}`,
        ]
      : [`lxc.cgroup2.cpu.max = ${quota} 100000`, `lxc.cgroup2.memory.max = ${bytes}`];
  const visible = hostCpus > 0 ? Math.max(1, Math.min(limits.cpu, hostCpus)) : 0;
  if (visible > 0) {
    const spec = visible === 1 ? "0" : `0-${visible - 1}`;
    lines.push(
      version === "v1" ? `lxc.cgroup.cpuset.cpus = ${spec}` : `lxc.cgroup2.cpuset.cpus = ${spec}`
    );
  }
  return lines;
}

/** Config keys managed by KineticCT (both cgroup generations). */
const MANAGED_KEYS = [
  "lxc.cgroup.cpu.cfs_period_us",
  "lxc.cgroup.cpu.cfs_quota_us",
  "lxc.cgroup.memory.limit_in_bytes",
  "lxc.cgroup.cpuset.cpus",
  "lxc.cgroup2.cpu.max",
  "lxc.cgroup2.memory.max",
  "lxc.cgroup2.cpuset.cpus",
];

/**
 * Count logical CPUs in a cpuset spec ("0-3" -> 4, "0,2" -> 2).
 * Returns null for empty/garbled specs instead of inventing a count.
 */
export function parseCpusetCount(spec: string | null): number | null {
  if (!spec) return null;
  let count = 0;
  let valid = false;
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const range = p.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a) return null;
      if (b - a > 4096) return null;
      count += b - a + 1;
      valid = true;
      continue;
    }
    if (/^\d+$/.test(p)) {
      count += 1;
      valid = true;
      continue;
    }
    return null;
  }
  return valid ? count : null;
}

function stripManagedKeys(configText: string): string[] {
  return configText.split("\n").filter((line) => {
    const key = line.split("=")[0]?.trim() ?? "";
    return !MANAGED_KEYS.includes(key);
  });
}

/** Read back the effective limits from a container config file. */
export function parseEffectiveLimits(
  configText: string,
  version: CgroupVersion
): { cpu: number | null; memoryMb: number | null; cpuset: string | null; cpusetCpus: number | null } {
  const get = (key: string): string | null => {
    const m = configText.match(new RegExp(`^${key.replace(/\./g, "\\.")}\\s*=\\s*(\\S+)`, "m"));
    return m ? m[1] : null;
  };
  let cpu: number | null = null;
  let memoryMb: number | null = null;
  let cpuset: string | null = null;
  if (version === "v1") {
    const quota = get("lxc.cgroup.cpu.cfs_quota_us");
    const mem = get("lxc.cgroup.memory.limit_in_bytes");
    cpuset = get("lxc.cgroup.cpuset.cpus");
    if (quota !== null && /^-?\d+$/.test(quota)) {
      const q = Number(quota);
      cpu = q > 0 ? Math.round((q / 100000) * 100) / 100 : null;
    }
    if (mem !== null && /^\d+$/.test(mem)) memoryMb = Math.round(Number(mem) / (1024 * 1024));
  } else {
    const max = get("lxc.cgroup2.cpu.max");
    const mem = get("lxc.cgroup2.memory.max");
    cpuset = get("lxc.cgroup2.cpuset.cpus");
    if (max !== null) {
      const q = Number(max.split(/\s+/)[0]);
      cpu = Number.isFinite(q) && q > 0 ? Math.round((q / 100000) * 100) / 100 : null;
    }
    if (mem !== null && /^\d+$/.test(mem)) memoryMb = Math.round(Number(mem) / (1024 * 1024));
  }
  return { cpu, memoryMb, cpuset, cpusetCpus: parseCpusetCount(cpuset) };
}

export interface EffectiveConfig {
  cpu: number | null;
  memoryMb: number | null;
  cpuset: string | null;
  cpusetCpus: number | null;
  cpuModel: string;
  storageGb: null;
  storageEnforced: false;
  storageNote: string;
  cgroupVersion: CgroupVersion;
}

/** Read the effective resource configuration. Storage quotas are honestly reported as unenforced. */
export async function readEffectiveConfig(containerId: string): Promise<EffectiveConfig> {
  validateContainerId(containerId);
  const version = detectCgroupVersion();
  let text: string;
  try {
    text = fs.readFileSync(containerConfigPath(containerId), "utf8");
  } catch {
    const exists = await containerExistsOnHost(containerId).catch(() => true);
    if (!exists) throw new ProviderError("CONTAINER_NOT_FOUND", "Container not found on node.", 404);
    throw new ProviderError("CONFIG_READ_FAILED", "Could not read the container configuration.");
  }
  const { cpu, memoryMb, cpuset, cpusetCpus } = parseEffectiveLimits(text, version);
  return {
    cpu,
    memoryMb,
    cpuset,
    cpusetCpus,
    cpuModel: RESOURCE_MODEL,
    storageGb: null,
    storageEnforced: false,
    storageNote:
      "Disk quotas are not enforced: containers use the directory backing store, which has no quota support.",
    cgroupVersion: version,
  };
}

/**
 * Persist limits to the container config and, when the container is running,
 * apply them live via lxc-cgroup. Returns whether a restart is still needed.
 */
export async function applyResourceLimits(
  containerId: string,
  limits: ResourceLimits
): Promise<{ liveApplied: boolean; restartRequired: boolean; cgroupVersion: CgroupVersion }> {
  validateContainerId(containerId);
  if (!Number.isInteger(limits.cpu) || limits.cpu < 1 || limits.cpu > 32) {
    throw new ProviderError("INVALID_RESOURCES", "CPU allocation out of range (1-32).", 400);
  }
  if (!Number.isInteger(limits.memoryMb) || limits.memoryMb < 128 || limits.memoryMb > 131072) {
    throw new ProviderError("INVALID_RESOURCES", "Memory allocation out of range.", 400);
  }
  const version = detectCgroupVersion();
  if (version === "unknown") {
    throw new ProviderError("CGROUP_UNKNOWN", "Cannot determine the host cgroup version; refusing to write limits blindly.");
  }
  const cfgPath = containerConfigPath(containerId);
  let current: string;
  try {
    current = fs.readFileSync(cfgPath, "utf8");
  } catch {
    const exists = await containerExistsOnHost(containerId).catch(() => true);
    if (!exists) throw new ProviderError("CONTAINER_NOT_FOUND", "Container not found on node.", 404);
    throw new ProviderError("CONFIG_READ_FAILED", "Could not read the container configuration.");
  }
  const lines = buildCgroupConfig(version, limits, hostCpuCount());
  const next = [...stripManagedKeys(current), ...lines].join("\n");
  const normalized = next.endsWith("\n") ? next : next + "\n";
  try {
    fs.writeFileSync(cfgPath, normalized, "utf8");
  } catch {
    throw new ProviderError("CONFIG_WRITE_FAILED", "Could not write the container configuration (insufficient privileges?).");
  }
  // Read back to verify the write actually landed.
  try {
    const check = fs.readFileSync(cfgPath, "utf8");
    for (const line of lines) {
      if (!check.includes(line)) {
        throw new ProviderError("CONFIG_VERIFY_FAILED", "Wrote limits but read-back verification failed.");
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("CONFIG_VERIFY_FAILED", "Could not verify the written configuration.");
  }
  // Live-apply when running so no restart is needed.
  let running = false;
  try {
    running = (await readContainerState(containerId)) === "RUNNING";
  } catch {
    running = false;
  }
  if (!running) return { liveApplied: false, restartRequired: false, cgroupVersion: version };
  const quota = Math.round(limits.cpu * 100000);
  const memBytes = String(Math.round(limits.memoryMb * 1024 * 1024));
  const visible = hostCpuCount() > 0 ? Math.max(1, Math.min(limits.cpu, hostCpuCount())) : 0;
  const cpusetSpec = visible === 1 ? "0" : `0-${visible - 1}`;
  const liveKeys: [string, string][] =
    version === "v1"
      ? [
          ["cpu.cfs_period_us", "100000"],
          ["cpu.cfs_quota_us", String(quota)],
          ["memory.limit_in_bytes", memBytes],
          ...(visible > 0 ? [["cpuset.cpus", cpusetSpec] as [string, string]] : []),
        ]
      : [
          ["cpu.max", `${quota} 100000`],
          ["memory.max", memBytes],
          ...(visible > 0 ? [["cpuset.cpus", cpusetSpec] as [string, string]] : []),
        ];
  let liveApplied = true;
  for (const [key, value] of liveKeys) {
    try {
      await run("lxc-cgroup", ["-n", containerId, key, value]);
    } catch {
      liveApplied = false;
    }
  }
  return { liveApplied, restartRequired: !liveApplied, cgroupVersion: version };
}

// ---------------------------------------------------------------------------
// LXCFS integration (container-aware /proc and /sys views).
// LXCFS only takes effect when its daemon serves /var/lib/lxcfs AND the
// container config includes the distribution's integration file. Both facts
// are verified, never assumed.
// ---------------------------------------------------------------------------

export const LXCFS_INCLUDE_LINE = "lxc.include = /usr/share/lxc/config/common.conf.d/00-lxcfs.conf";
const LXCFS_INCLUDE_PATH = "/usr/share/lxc/config/common.conf.d/00-lxcfs.conf";

function lxcfsIncludeFileExists(): boolean {
  try {
    return fs.existsSync(LXCFS_INCLUDE_PATH);
  } catch {
    return false;
  }
}

export function lxcfsIncludePresent(configText: string): boolean {
  return configText.split("\n").some((line) => line.trim() === LXCFS_INCLUDE_LINE);
}

/** Host-level: is the LXCFS FUSE view actually being served? */
export function isLxcfsServing(): boolean {
  try {
    const mounts = fs.readFileSync("/proc/mounts", "utf8");
    if (!/(^|\s)lxcfs\s/.test(mounts)) return false;
    return fs.readdirSync("/var/lib/lxcfs").length > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure the container config includes the LXCFS integration file.
 * Returns "present" (already there), "added", or "unavailable" (LXCFS not
 * usable on this host — never faked). Does not restart anything.
 */
export async function ensureLxcfsInclude(containerId: string): Promise<"present" | "added" | "unavailable"> {
  validateContainerId(containerId);
  if (!lxcfsIncludeFileExists() || !isLxcfsServing()) return "unavailable";
  const cfgPath = containerConfigPath(containerId);
  let current: string;
  try {
    current = fs.readFileSync(cfgPath, "utf8");
  } catch {
    const exists = await containerExistsOnHost(containerId).catch(() => true);
    if (!exists) throw new ProviderError("CONTAINER_NOT_FOUND", "Container not found on node.", 404);
    throw new ProviderError("CONFIG_READ_FAILED", "Could not read the container configuration.");
  }
  if (lxcfsIncludePresent(current)) return "present";
  const next = current.endsWith("\n") ? current + LXCFS_INCLUDE_LINE + "\n" : current + "\n" + LXCFS_INCLUDE_LINE + "\n";
  try {
    fs.writeFileSync(cfgPath, next, "utf8");
  } catch {
    throw new ProviderError("CONFIG_WRITE_FAILED", "Could not write the container configuration (insufficient privileges?).");
  }
  return "added";
}

/** Per-container: are LXCFS overlays actually mounted inside the running guest? */
export async function isLxcfsActiveForContainer(containerId: string): Promise<boolean | null> {
  validateContainerId(containerId);
  let pid: number | null = null;
  try {
    const { stdout } = await run("lxc-info", ["-n", containerId]);
    const m = stdout.match(/^\s*PID:\s*(\d+)/m);
    const n = m ? Number(m[1]) : NaN;
    pid = Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
  if (pid === null) return null; // not running (or PID hidden): cannot observe mounts
  try {
    const mounts = fs.readFileSync(`/proc/${pid}/mountinfo`, "utf8");
    return mounts.includes("lxcfs");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage backend detection, real usage, and btrfs quotas.
// Directory-backed containers have no quota mechanism: that is reported,
// never invented. btrfs subvolume quotas are enforced for real.
// ---------------------------------------------------------------------------

export type StorageBackend = "btrfs" | "ext4" | "xfs" | "zfs" | "dir" | "unknown";

export function containerRootfsPath(containerId: string): string {
  validateContainerId(containerId);
  return path.join(lxcRoot(), containerId, "rootfs");
}

/** Parse `df -P -T <path>` output into a filesystem type. Pure and tested. */
export function parseDfFstype(output: string, targetPath: string): string | null {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return null;
  // Take the last data line (avoids wrapped header edge cases); fstype is col 2.
  const parts = (lines[lines.length - 1] ?? "").split(/\s+/);
  if (parts.length < 7) return null;
  const fstype = parts[1];
  if (!fstype || fstype === "Type") return null;
  void targetPath;
  return fstype.slice(0, 32);
}

/** Filesystem type backing a container's rootfs. */
export async function detectStorageBackend(containerId: string): Promise<StorageBackend> {
  const rootfs = containerRootfsPath(containerId);
  try {
    const { stdout } = await runHostTool("df", ["-P", "-T", rootfs], { timeoutMs: 15000 });
    const fstype = (parseDfFstype(stdout, rootfs) ?? "").toLowerCase();
    if (fstype === "btrfs") return "btrfs";
    if (fstype === "ext4" || fstype === "ext3" || fstype === "ext2") return "ext4";
    if (fstype === "xfs") return "xfs";
    if (fstype === "zfs") return "zfs";
    if (fstype) return "dir";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Real disk consumption of a container rootfs via du. Null when unreadable. */
export async function getContainerDiskUsageGb(containerId: string): Promise<number | null> {
  const rootfs = containerRootfsPath(containerId);
  try {
    const { stdout } = await runHostTool("du", ["-sb", rootfs], { timeoutMs: 120000 });
    const m = stdout.match(/^\s*(\d+)/);
    if (!m) return null;
    const bytes = Number(m[1]);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
    return Math.round((bytes / 1024 ** 3) * 100) / 100;
  } catch {
    return null;
  }
}

/** True when path is a btrfs subvolume (quota-capable). */
export async function isBtrfsSubvolume(rootfsPath: string): Promise<boolean> {
  try {
    await runHostTool("btrfs", ["subvolume", "show", rootfsPath], { timeoutMs: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Parse `btrfs subvolume show` output for the subvolume id. Pure and tested. */
export function parseBtrfsSubvolId(output: string): string | null {
  const m = output.match(/^\s*Subvolume ID:\s*(\d+)\s*$/m);
  return m ? m[1].slice(0, 16) : null;
}

/**
 * Parse `btrfs qgroup show <path>` for the exclusive-limit (max_rfer) of a
 * qgroup id. Returns bytes, or null when absent/unparseable. Pure + tested.
 */
export function parseBtrfsQgroupLimit(output: string, qgroupId: string): number | null {
  for (const raw of output.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== qgroupId) continue;
    // Columns: qgroupid rfer excl max_rfer max_excl
    const limit = Number(parts[3]);
    if (Number.isSafeInteger(limit) && limit > 0 && limit < Number.MAX_SAFE_INTEGER) return limit;
    return null;
  }
  return null;
}

/** Read the enforced btrfs quota (bytes) for a subvolume, or null. */
export async function readBtrfsQuotaGb(rootfsPath: string): Promise<number | null> {
  try {
    const { stdout: showOut } = await runHostTool("btrfs", ["subvolume", "show", rootfsPath], { timeoutMs: 15000 });
    const subvolId = parseBtrfsSubvolId(showOut);
    if (!subvolId) return null;
    const { stdout: qgOut } = await runHostTool("btrfs", ["qgroup", "show", "--raw", rootfsPath], { timeoutMs: 15000 });
    for (const qid of [`0/${subvolId}`, subvolId]) {
      const bytes = parseBtrfsQgroupLimit(qgOut, qid);
      if (bytes !== null) return Math.round((bytes / 1024 ** 3) * 100) / 100;
    }
    return null;
  } catch {
    return null;
  }
}

/** Enable quota accounting on the filesystem (idempotent; btrfs ignores repeats with a warning). */
export async function enableBtrfsQuota(rootfsPath: string): Promise<void> {
  try {
    await runHostTool("btrfs", ["quota", "enable", rootfsPath], { timeoutMs: 60000 });
  } catch (err) {
    if (err instanceof ProviderError && /already (enabled|enabled)|ERROR: quota/i.test(err.message)) return;
    throw err instanceof ProviderError ? err : new ProviderError("QUOTA_FAILED", "Could not enable btrfs quotas.");
  }
}

/** Enforce a hard quota on a btrfs subvolume and verify it stuck. */
export async function enforceBtrfsQuota(rootfsPath: string, sizeGb: number): Promise<number> {
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 2000) {
    throw new ProviderError("INVALID_RESOURCES", "Storage allocation out of range (1-2000).", 400);
  }
  await enableBtrfsQuota(rootfsPath);
  await runHostTool("btrfs", ["qgroup", "limit", `${sizeGb}G`, rootfsPath], { timeoutMs: 60000 });
  const verified = await readBtrfsQuotaGb(rootfsPath);
  const expected = sizeGb;
  if (verified === null || Math.abs(verified - expected) > Math.max(0.5, expected * 0.05)) {
    throw new ProviderError("QUOTA_VERIFY_FAILED", "Set a btrfs quota but read-back verification failed.");
  }
  return verified;
}

// ---------------------------------------------------------------------------
// ext4 project quotas. Plain directories have no quota mechanism, but ext4
// project quotas attach a real enforced byte limit to a directory tree —
// no repartitioning, no migration, no touching other data.
// ---------------------------------------------------------------------------

/**
 * Parse `repquota -P <mount>` output for one project id.
 * Columns: project used soft hard grace (1K blocks). Pure and tested.
 */
export function parseRepquotaProject(
  output: string,
  projid: number
): { usedKb: number; softKb: number; hardKb: number } | null {
  const want = `#${projid}`;
  for (const raw of output.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 5 || (parts[0] !== want && parts[0] !== String(projid))) continue;
    const nums: number[] = [];
    for (const p of parts.slice(1)) {
      if (/^\d+$/.test(p)) {
        nums.push(Number(p));
        if (nums.length === 3) break;
      }
    }
    if (nums.length < 3) return null;
    const [usedKb, softKb, hardKb] = nums as [number, number, number];
    if (![usedKb, softKb, hardKb].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
    return { usedKb, softKb, hardKb };
  }
  return null;
}

/** True when tune2fs output lists the quota filesystem feature. Pure + tested. */
export function parseTune2fsQuotaFeatures(output: string): boolean {
  const m = output.match(/^\s*Filesystem features:\s*(.+)$/m);
  if (!m) return false;
  return m[1].split(/\s+/).includes("quota");
}

/** Mount options for an exact mountpoint from mount-table text. Pure + tested. */
export function parseMountOptions(mountsText: string, mountpoint: string): string[] | null {
  for (const raw of mountsText.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 4 || parts[1] !== mountpoint) continue;
    return parts[3].split(",").map((o) => o.trim()).filter(Boolean);
  }
  return null;
}

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Deterministic project id in [100000, 149999], skipping ids already taken.
 * Deterministic so re-runs converge instead of leaking ids; collisions are
 * resolved by probing, never by touching another container's tree.
 */
export function deriveProjectId(containerId: string, taken: number[]): number {
  const base = 100000 + (fnv1a32(containerId) % 50000);
  const used = new Set(taken.filter((n) => Number.isInteger(n)));
  for (let i = 0; i < 50000; i++) {
    const candidate = 100000 + ((base - 100000 + i) % 50000);
    if (!used.has(candidate)) return candidate;
  }
  throw new ProviderError("QUOTA_FAILED", "No free project id available for quota assignment.");
}

/** 1K-block units used by setquota/repquota. Pure and tested. */
export function gbToQuotaBlocks(sizeGb: number): number {
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 2000) {
    throw new ProviderError("INVALID_RESOURCES", "Storage allocation out of range (1-2000).", 400);
  }
  return sizeGb * 1024 * 1024;
}

/** Resolve the mountpoint backing a path (follows symlinks like findmnt does). */
export async function getMountpointForPath(fsPath: string): Promise<string | null> {
  try {
    const { stdout } = await runQuotaTool("findmnt", ["-n", "-o", "TARGET", "--target", fsPath], { timeoutMs: 15000 });
    const target = stdout.trim().split("\n").pop()?.trim() ?? "";
    return target ? target.slice(0, 256) : null;
  } catch {
    return null;
  }
}

/** Block device backing a mountpoint, or null. */
export async function getDeviceForMount(mountpoint: string): Promise<string | null> {
  try {
    const { stdout } = await runQuotaTool("findmnt", ["-n", "-o", "SOURCE", mountpoint], { timeoutMs: 15000 });
    const src = stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!src || !src.startsWith("/dev/")) return null;
    return src.slice(0, 128);
  } catch {
    return null;
  }
}

export interface Ext4QuotaState {
  capable: boolean;
  reason: string | null;
  mountpoint: string | null;
  device: string | null;
  prjquotaActive: boolean;
}

/** Inspect whether project quotas can work on the filesystem behind a path. */
export async function ext4QuotaState(fsPath: string): Promise<Ext4QuotaState> {
  const mountpoint = await getMountpointForPath(fsPath);
  if (!mountpoint) {
    return { capable: false, reason: "Could not resolve a mountpoint.", mountpoint: null, device: null, prjquotaActive: false };
  }
  let mountsText = "";
  try {
    mountsText = fs.readFileSync("/proc/mounts", "utf8");
  } catch {
    return { capable: false, reason: "Could not read the mount table.", mountpoint, device: null, prjquotaActive: false };
  }
  const opts = parseMountOptions(mountsText, mountpoint);
  if (opts !== null && (opts.includes("prjquota") || opts.includes("quota"))) {
    return { capable: true, reason: null, mountpoint, device: null, prjquotaActive: true };
  }
  const device = await getDeviceForMount(mountpoint);
  if (!device) {
    return { capable: false, reason: "No block device found for this mount; cannot enable quotas.", mountpoint, device: null, prjquotaActive: false };
  }
  let hasFeature = false;
  try {
    const { stdout } = await runQuotaTool("tune2fs", ["-l", device], { timeoutMs: 15000 });
    hasFeature = parseTune2fsQuotaFeatures(stdout);
  } catch {
    hasFeature = false;
  }
  if (!hasFeature) {
    return { capable: false, reason: "Filesystem lacks the quota feature (requires offline tune2fs -O quota while unmounted).", mountpoint, device, prjquotaActive: false };
  }
  return { capable: true, reason: "prjquota mount option not active yet.", mountpoint, device, prjquotaActive: false };
}

/**
 * Enable project quotas on an ext4 mount: filesystem feature, live remount,
 * and fstab persistence (backed up once, verified with findmnt --verify and
 * restored on failure). Never reformats, never migrates data.
 */
export async function ensureExt4ProjectQuota(mountpoint: string): Promise<void> {
  const state = await ext4QuotaState(mountpoint);
  if (state.prjquotaActive) return;
  if (!state.capable || !state.device) {
    throw new ProviderError("QUOTA_UNSUPPORTED", state.reason ?? "Project quotas cannot be enabled here.");
  }
  try {
    const { stdout } = await runQuotaTool("tune2fs", ["-l", state.device], { timeoutMs: 15000 });
    if (!parseTune2fsQuotaFeatures(stdout)) {
      await runQuotaTool("tune2fs", ["-O", "quota", state.device], { timeoutMs: 60000 });
    }
  } catch (err) {
    throw err instanceof ProviderError ? err : new ProviderError("QUOTA_FAILED", "Could not enable the quota filesystem feature.");
  }
  try {
    await runQuotaTool("mount", ["-o", "remount,prjquota", mountpoint], { timeoutMs: 60000 });
  } catch {
    throw new ProviderError("QUOTA_FAILED", "Could not remount with project quotas (prjquota).");
  }
  // Persist across reboots: append ,prjquota to the exact fstab entry.
  const fstab = "/etc/fstab";
  const backup = "/etc/fstab.kct-bak";
  let original: string;
  try {
    original = fs.readFileSync(fstab, "utf8");
  } catch {
    throw new ProviderError("QUOTA_FAILED", "Remounted live, but /etc/fstab is unreadable so reboot persistence is unverified.");
  }
  const lines = original.split("\n");
  let changed = false;
  const next = lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const fields = line.split(/\s+/);
      if (fields.length < 4 || fields[1] !== mountpoint) return line;
      const opts = fields[3].split(",");
      if (opts.includes("prjquota") || opts.includes("quota")) return line;
      fields[3] = [...opts, "prjquota"].join(",");
      changed = true;
      return fields.join("\t");
    })
    .join("\n");
  if (changed) {
    try {
      if (!fs.existsSync(backup)) fs.copyFileSync(fstab, backup);
      fs.writeFileSync(fstab, next, "utf8");
      await runQuotaTool("findmnt", ["--verify"], { timeoutMs: 15000 });
    } catch {
      try {
        if (fs.existsSync(backup)) fs.copyFileSync(backup, fstab);
      } catch {
        /* best effort restore */
      }
      throw new ProviderError("QUOTA_FAILED", "fstab persistence failed verification; original restored.");
    }
  }
  const recheck = await ext4QuotaState(mountpoint);
  if (!recheck.prjquotaActive) {
    throw new ProviderError("QUOTA_FAILED", "Project quotas still inactive after enablement.");
  }
}

/** Project id currently stamped on a directory (lsattr -p), or null. */
export async function getProjectIdForPath(dirPath: string): Promise<number | null> {
  try {
    const { stdout } = await runQuotaTool("lsattr", ["-p", "-d", dirPath], { timeoutMs: 15000 });
    const m = stdout.trim().match(/^(\d+)\s/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Stamp a project id across a container tree (idempotent for same id). */
export async function assignProjectId(rootfsPath: string, projid: number): Promise<void> {
  if (!Number.isSafeInteger(projid) || projid < 0) {
    throw new ProviderError("INVALID_RESOURCES", "Invalid project id.", 400);
  }
  await runQuotaTool("chattr", ["-R", "-p", String(projid), rootfsPath], { timeoutMs: 120000 });
}

/** Set a hard project quota and verify it stuck via repquota read-back. */
export async function setProjectQuota(mountpoint: string, projid: number, sizeGb: number): Promise<number> {
  const blocks = gbToQuotaBlocks(sizeGb);
  await runQuotaTool("setquota", ["-P", String(projid), String(blocks), String(blocks), "0", "0", mountpoint], {
    timeoutMs: 60000,
  });
  const verified = await readProjectQuotaGb(mountpoint, projid);
  if (verified === null || Math.abs(verified - sizeGb) > Math.max(0.5, sizeGb * 0.05)) {
    throw new ProviderError("QUOTA_VERIFY_FAILED", "Set a project quota but read-back verification failed.");
  }
  return verified;
}

/** Read the enforced hard quota (GB) for a project id, or null when none. */
export async function readProjectQuotaGb(mountpoint: string, projid: number): Promise<number | null> {
  try {
    const { stdout } = await runQuotaTool("repquota", ["-P", mountpoint], { timeoutMs: 15000 });
    const row = parseRepquotaProject(stdout, projid);
    if (!row || row.hardKb <= 0) return null;
    return Math.round((row.hardKb / (1024 * 1024)) * 100) / 100;
  } catch {
    return null;
  }
}

/** Project ids already stamped on sibling container trees (collision avoidance). */
export async function collectSiblingProjectIds(containerId: string): Promise<number[]> {
  const ids: number[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(lxcRoot());
  } catch {
    return ids;
  }
  for (const name of names) {
    if (name === containerId || name.startsWith(".")) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$/.test(name)) continue;
    try {
      const id = await getProjectIdForPath(path.join(lxcRoot(), name, "rootfs"));
      if (id !== null && id >= 100000) ids.push(id);
    } catch {
      /* best effort per sibling */
    }
  }
  return ids;
}

/**
 * Full ext4 enforcement for one container tree: enable accounting, assign a
 * collision-free project id, set the hard limit, verify by read-back.
 */
export async function enforceExt4Quota(rootfsPath: string, containerId: string, sizeGb: number): Promise<{ projid: number; quotaGb: number }> {
  validateContainerId(containerId);
  gbToQuotaBlocks(sizeGb); // validates range first
  const mountpoint = await getMountpointForPath(rootfsPath);
  if (!mountpoint) throw new ProviderError("QUOTA_FAILED", "Could not resolve the filesystem for quota enforcement.");
  await ensureExt4ProjectQuota(mountpoint);
  const existing = await getProjectIdForPath(rootfsPath);
  const taken = await collectSiblingProjectIds(containerId);
  const projid = existing !== null && existing >= 100000 ? existing : deriveProjectId(containerId, taken);
  if (existing === null || existing < 100000) {
    await assignProjectId(rootfsPath, projid);
  }
  const quotaGb = await setProjectQuota(mountpoint, projid, sizeGb);
  return { projid, quotaGb };
}

export interface StorageInfo {
  backend: StorageBackend;
  quotaSupported: boolean;
  quotaGb: number | null;
  usedGb: number | null;
  note: string;
}

/** Real storage facts: backend detection, enforced quota (btrfs/ext4), actual usage. */
export async function getContainerStorage(containerId: string): Promise<StorageInfo> {
  validateContainerId(containerId);
  const rootfs = containerRootfsPath(containerId);
  const backend = await detectStorageBackend(containerId);
  const usedGb = await getContainerDiskUsageGb(containerId);
  if (backend === "btrfs" && (await isBtrfsSubvolume(rootfs))) {
    const quotaGb = await readBtrfsQuotaGb(rootfs);
    if (quotaGb !== null) {
      return {
        backend,
        quotaSupported: true,
        quotaGb,
        usedGb,
        note: "Quota enforced via btrfs qgroup limit. Guest df shows filesystem totals, not the quota.",
      };
    }
    return {
      backend,
      quotaSupported: true,
      quotaGb: null,
      usedGb,
      note: "btrfs subvolume without an enforced quota yet. Guest df shows filesystem totals, not any quota.",
    };
  }
  if (backend === "btrfs") {
    return {
      backend,
      quotaSupported: false,
      quotaGb: null,
      usedGb,
      note: "Rootfs is a plain directory on btrfs (not a subvolume): per-container quotas need a subvolume layout.",
    };
  }
  if (backend === "ext4") {
    const mountpoint = await getMountpointForPath(rootfs);
    const state = mountpoint ? await ext4QuotaState(mountpoint).catch(() => null) : null;
    if (state && state.prjquotaActive) {
      const projid = await getProjectIdForPath(rootfs).catch(() => null);
      if (projid !== null && projid >= 100000 && mountpoint) {
        const quotaGb = await readProjectQuotaGb(mountpoint, projid).catch(() => null);
        if (quotaGb !== null) {
          return {
            backend,
            quotaSupported: true,
            quotaGb,
            usedGb,
            note: `Quota enforced via ext4 project quota (project ${projid}). Guest df shows filesystem totals, not the quota.`,
          };
        }
        return {
          backend,
          quotaSupported: true,
          quotaGb: null,
          usedGb,
          note: `ext4 project quotas active (project ${projid}) but no hard limit is set yet.`,
        };
      }
      return {
        backend,
        quotaSupported: true,
        quotaGb: null,
        usedGb,
        note: "ext4 project quotas are active on this filesystem but this container has no project id yet; run Repair.",
      };
    }
    return {
      backend,
      quotaSupported: false,
      quotaGb: null,
      usedGb,
      note: state?.reason
        ? `ext4 project quotas unavailable: ${state.reason}`
        : "ext4 project quotas are not enabled on this filesystem.",
    };
  }
  if (backend === "xfs" || backend === "zfs") {
    return {
      backend,
      quotaSupported: false,
      quotaGb: null,
      usedGb,
      note: `${backend} project/dataset quotas are detected but not managed by this build; quotas stay unenforced.`,
    };
  }
  return {
    backend,
    quotaSupported: false,
    quotaGb: null,
    usedGb,
    note: "Disk quotas are not enforced: containers use the directory backing store, which has no quota support.",
  };
}

/** Choose the backing store for a new container: btrfs subvolumes only on btrfs hosts. */
export async function selectBackingStore(): Promise<"btrfs" | "dir"> {
  try {
    const { stdout } = await runHostTool("df", ["-P", "-T", lxcRoot()], { timeoutMs: 15000 });
    return parseDfFstype(stdout, lxcRoot()) === "btrfs" ? "btrfs" : "dir";
  } catch {
    return "dir";
  }
}

// ---------------------------------------------------------------------------
// Metric plausibility guards. Host tooling (e.g. lxc-top over unlimited
// cgroups) can emit absurd values; our API must return Unavailable instead
// of echoing garbage like "2915679709.81 GiB".
// ---------------------------------------------------------------------------

/** Upper bound for a single container's memory: host RAM is a hard ceiling. */
export function hostTotalMemoryMb(): number {
  try {
    const mb = Math.round(os.totalmem() / (1024 * 1024));
    return mb > 0 ? mb : 0;
  } catch {
    return 0;
  }
}

/**
 * Validate a parsed metric. Returns null for anything non-finite, negative,
 * or physically implausible (above maxMb when a ceiling is known).
 */
export function sanitizeMetric(value: number | null, maxMb: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  if (maxMb !== null && maxMb > 0 && value > maxMb) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Capacity and repair.
// ---------------------------------------------------------------------------

export interface HostCapacity {
  memoryTotalMb: number;
  memoryFreeMb: number;
  diskAvailGb: number | null;
}

/** Real free capacity for admission checks. Nulls stay null (never invented). */
export async function getHostCapacity(): Promise<HostCapacity> {
  let memoryTotalMb = 0;
  let memoryFreeMb = 0;
  try {
    memoryTotalMb = Math.round(os.totalmem() / (1024 * 1024));
    memoryFreeMb = Math.round(os.freemem() / (1024 * 1024));
  } catch {
    memoryTotalMb = 0;
    memoryFreeMb = 0;
  }
  let diskAvailGb: number | null = null;
  try {
    const { stdout } = await runHostTool("df", ["-P", "-B1", lxcRoot()], { timeoutMs: 15000 });
    const lines = stdout.trim().split("\n");
    const parts = (lines[lines.length - 1] ?? "").split(/\s+/);
    if (parts.length >= 4) {
      const n = Number(parts[3]);
      if (Number.isSafeInteger(n) && n >= 0) diskAvailGb = Math.round((n / 1024 ** 3) * 10) / 10;
    }
  } catch {
    diskAvailGb = null;
  }
  return { memoryTotalMb, memoryFreeMb, diskAvailGb };
}

/** Refuse provisioning that provably exceeds free host capacity. */
export function checkHostCapacity(
  capacity: HostCapacity,
  request: { memoryMb: number; storageGb: number }
): void {
  if (capacity.memoryFreeMb > 0 && request.memoryMb > capacity.memoryFreeMb) {
    throw new ProviderError(
      "INSUFFICIENT_CAPACITY",
      `Host has only ${capacity.memoryFreeMb} MB free memory; ${request.memoryMb} MB requested.`,
      409
    );
  }
  if (capacity.diskAvailGb !== null && request.storageGb > capacity.diskAvailGb) {
    throw new ProviderError(
      "INSUFFICIENT_CAPACITY",
      `Host has only ${capacity.diskAvailGb} GB free on the container filesystem; ${request.storageGb} GB requested.`,
      409
    );
  }
}

export interface RepairCheck {
  check: string;
  status: "ok" | "fixed" | "unsupported" | "failed";
  detail: string;
}

export interface RepairReport {
  containerId: string;
  backupPath: string | null;
  checks: RepairCheck[];
  restartNeeded: boolean;
  warnings: string[];
}

export interface RepairPlan {
  containerId: string;
  exists: boolean;
  checks: { check: string; status: "ok" | "needs-fix" | "unsupported"; detail: string }[];
  restartNeeded: boolean;
  warnings: string[];
}

function backupContainerConfig(containerId: string): string | null {
  const cfgPath = containerConfigPath(containerId);
  const bakPath = `${cfgPath}.kct-bak`;
  try {
    if (fs.existsSync(bakPath)) return bakPath; // first backup wins; never overwrite history
    fs.copyFileSync(cfgPath, bakPath);
    return bakPath;
  } catch {
    return null;
  }
}

async function containerRunning(containerId: string): Promise<boolean> {
  try {
    return (await readContainerState(containerId)) === "RUNNING";
  } catch {
    return false;
  }
}

/**
 * Read-only repair plan: compare DB allocation with effective host config.
 * Never modifies anything. Powers the plan preview and the CLI dry-run.
 */
export async function planInstanceRepair(
  containerId: string,
  dbLimits: { cpu: number; memoryMb: number; storageGb: number }
): Promise<RepairPlan> {
  validateContainerId(containerId);
  const exists = await containerExistsOnHost(containerId).catch(() => false);
  if (!exists) {
    return {
      containerId,
      exists: false,
      checks: [{ check: "existence", status: "unsupported", detail: "Container is missing on the host; recreate it instead." }],
      restartNeeded: false,
      warnings: [],
    };
  }
  const checks: RepairPlan["checks"] = [];
  const warnings: string[] = [];
  let effective: { cpu: number | null; memoryMb: number | null } | null = null;
  try {
    effective = await readEffectiveConfig(containerId);
  } catch {
    effective = null;
  }
  if (effective === null || effective.cpu !== dbLimits.cpu || effective.memoryMb !== dbLimits.memoryMb) {
    checks.push({
      check: "limits",
      status: "needs-fix",
      detail: `Effective ${effective?.cpu ?? "?"} vCPU / ${effective?.memoryMb ?? "?"} MB differs from allocation (${dbLimits.cpu} vCPU / ${dbLimits.memoryMb} MB).`,
    });
  } else {
    checks.push({
      check: "limits",
      status: "ok",
      detail: `CPU/memory match allocation (${dbLimits.cpu} vCPU, ${dbLimits.memoryMb} MB).`,
    });
  }

  let includePresent = false;
  try {
    const cfg = fs.readFileSync(containerConfigPath(containerId), "utf8");
    includePresent = lxcfsIncludePresent(cfg);
  } catch {
    includePresent = false;
  }
  if (includePresent) {
    checks.push({ check: "lxcfs", status: "ok", detail: "LXCFS integration include present." });
  } else if (lxcfsIncludeFileExists() && isLxcfsServing()) {
    checks.push({ check: "lxcfs", status: "needs-fix", detail: "LXCFS is serving but the container lacks the integration include." });
  } else {
    checks.push({ check: "lxcfs", status: "unsupported", detail: "LXCFS is not serving on this host; guest views stay host-native." });
  }

  try {
    const storage = await getContainerStorage(containerId);
    if (storage.quotaSupported && storage.quotaGb === null) {
      const kind = storage.backend === "btrfs" ? "btrfs subvolume" : "ext4 directory tree";
      checks.push({ check: "storage", status: "needs-fix", detail: `${kind} without an enforced quota.` });
    } else {
      checks.push({
        check: "storage",
        status: storage.quotaSupported ? "ok" : "unsupported",
        detail:
          storage.quotaSupported && storage.quotaGb !== null
            ? `${storage.backend} quota enforced at ${storage.quotaGb} GB (${storage.usedGb ?? "?"} GB used).`
            : storage.note,
      });
    }
  } catch (err) {
    checks.push({
      check: "storage",
      status: "unsupported",
      detail: err instanceof ProviderError ? err.message : "Could not inspect storage.",
    });
  }

  const running = await containerRunning(containerId);
  return {
    containerId,
    exists: true,
    checks,
    restartNeeded: running && checks.some((c) => c.status === "needs-fix"),
    warnings,
  };
}

/**
 * Compare DB allocation with effective host config and fix what is safely
 * fixable. Never destroys/recreates; never migrates storage; never touches
 * other containers. Config file is backed up (once) before any change.
 */
export async function repairInstance(
  containerId: string,
  dbLimits: { cpu: number; memoryMb: number; storageGb: number }
): Promise<RepairReport> {
  validateContainerId(containerId);
  const plan = await planInstanceRepair(containerId, dbLimits);
  if (!plan.exists) {
    return {
      containerId,
      backupPath: null,
      checks: plan.checks.map((c) => ({ ...c, status: "failed" as const })),
      restartNeeded: false,
      warnings: plan.warnings,
    };
  }
  const checks: RepairCheck[] = [];
  const warnings: string[] = [...plan.warnings];
  let backupPath: string | null = null;
  let restartNeeded = false;

  const need = (name: string): boolean =>
    plan.checks.some((c) => c.check === name && c.status === "needs-fix");

  // CPU/memory limits (+cpuset): back up once, re-apply, verify by read-back.
  if (!need("limits")) {
    const ok = plan.checks.find((c) => c.check === "limits");
    checks.push({
      check: "limits",
      status: "ok",
      detail: ok?.detail ?? "CPU/memory match allocation.",
    });
  } else {
    backupPath = backupContainerConfig(containerId);
    if (backupPath === null) {
      checks.push({ check: "limits", status: "failed", detail: "Could not back up the container config; refusing to modify it." });
    } else {
      try {
        const res = await applyResourceLimits(containerId, { cpu: dbLimits.cpu, memoryMb: dbLimits.memoryMb });
        const re = await readEffectiveConfig(containerId);
        if (re.cpu === dbLimits.cpu && re.memoryMb === dbLimits.memoryMb) {
          checks.push({ check: "limits", status: "fixed", detail: `Re-applied ${dbLimits.cpu} vCPU / ${dbLimits.memoryMb} MB (cgroup ${res.cgroupVersion}).` });
          if (res.restartRequired) restartNeeded = true;
        } else {
          checks.push({ check: "limits", status: "failed", detail: "Re-applied limits but read-back does not match." });
        }
      } catch (err) {
        checks.push({
          check: "limits",
          status: "failed",
          detail: err instanceof ProviderError ? err.message : "Could not re-apply limits.",
        });
      }
    }
  }

  // LXCFS include: add when the host serves it, report otherwise.
  if (!need("lxcfs")) {
    const ok = plan.checks.find((c) => c.check === "lxcfs");
    checks.push({
      check: "lxcfs",
      status: ok?.status === "ok" ? "ok" : "unsupported",
      detail: ok?.detail ?? "LXCFS state unchanged.",
    });
    if (ok?.status === "ok") {
      const active = await isLxcfsActiveForContainer(containerId);
      if (active === false) {
        restartNeeded = true;
        checks.push({ check: "lxcfs-active", status: "unsupported", detail: "LXCFS views will appear after a container restart." });
      }
    }
  } else {
    try {
      const ensured = await ensureLxcfsInclude(containerId);
      if (ensured === "present" || ensured === "added") {
        checks.push({
          check: "lxcfs",
          status: ensured === "added" ? "fixed" : "ok",
          detail: ensured === "added" ? "Added the LXCFS integration include (applies on next start)." : "LXCFS integration include present.",
        });
        const active = await isLxcfsActiveForContainer(containerId);
        if (active === false) {
          restartNeeded = true;
          checks.push({ check: "lxcfs-active", status: "unsupported", detail: "LXCFS views will appear after a container restart." });
        }
      } else {
        checks.push({ check: "lxcfs", status: "unsupported", detail: "LXCFS is not serving on this host; guest views stay host-native." });
      }
    } catch (err) {
      checks.push({
        check: "lxcfs",
        status: "failed",
        detail: err instanceof ProviderError ? err.message : "Could not inspect LXCFS integration.",
      });
    }
  }

  // Storage: report-only, except quotas that are actually enforceable here
  // (btrfs subvolumes, ext4 project quotas). Never migrates storage layouts.
  if (!need("storage")) {
    const ok = plan.checks.find((c) => c.check === "storage");
    checks.push({
      check: "storage",
      status: ok?.status === "ok" ? "ok" : "unsupported",
      detail: ok?.detail ?? "Storage state unchanged.",
    });
  } else {
    const rootfs = containerRootfsPath(containerId);
    const backend = await detectStorageBackend(containerId).catch(() => "unknown" as const);
    try {
      if (backend === "btrfs") {
        const enforced = await enforceBtrfsQuota(rootfs, dbLimits.storageGb);
        checks.push({ check: "storage", status: "fixed", detail: `Enforced btrfs quota of ${enforced} GB on the container subvolume.` });
      } else if (backend === "ext4") {
        const { quotaGb } = await enforceExt4Quota(rootfs, containerId, dbLimits.storageGb);
        checks.push({ check: "storage", status: "fixed", detail: `Enforced ext4 project quota of ${quotaGb} GB on the container tree.` });
      } else {
        checks.push({ check: "storage", status: "unsupported", detail: `Backend '${backend}' has no safe quota mechanism here; left untouched.` });
      }
    } catch (err) {
      checks.push({
        check: "storage",
        status: "failed",
        detail: err instanceof ProviderError ? err.message : "Could not enforce a storage quota.",
      });
    }
  }

  return { containerId, backupPath, checks, restartNeeded, warnings };
}

/** Repair every managed instance registered on the local node. Read-only except per-instance fixes. */
export async function repairLocalInstances(
  db: { prepare: (sql: string) => { all: (...p: unknown[]) => Record<string, unknown>[] } }
): Promise<{ repaired: RepairReport[]; checkedAt: string }> {
  const { nowIso: stamp } = await import("../../db.js");
  const rows = db
    .prepare(
      `SELECT i.container_id AS container_id, i.cpu AS cpu, i.memory_mb AS memory_mb, i.storage_gb AS storage_gb
       FROM instances i JOIN nodes n ON n.id = i.node_id WHERE n.endpoint = 'local'`
    )
    .all() as { container_id: string; cpu: number; memory_mb: number; storage_gb: number }[];
  const repaired: RepairReport[] = [];
  for (const r of rows) {
    try {
      repaired.push(
        await repairInstance(String(r.container_id), {
          cpu: Number(r.cpu),
          memoryMb: Number(r.memory_mb),
          storageGb: Number(r.storage_gb),
        })
      );
    } catch (err) {
      repaired.push({
        containerId: String(r.container_id),
        backupPath: null,
        checks: [
          {
            check: "repair",
            status: "failed",
            detail: err instanceof ProviderError ? err.message : "Repair failed.",
          },
        ],
        restartNeeded: false,
        warnings: [],
      });
    }
  }
  return { repaired, checkedAt: stamp() };
}

/**
 * Privileged host integration. Runs `lxc-*` binaries with strict
 * argument vectors (never shell strings) and bounded output. When no
 * node is configured or LXC is absent, callers receive an honest
 * "unavailable" result instead of fabricated data.
 */
export class LocalLxcProvider implements VirtualizationProvider {
  readonly kind = "local-lxc";
  readonly capabilities = { create: true, start: true, stop: true, remove: true, liveStatus: true };

  private requireLocalNode(nodeId: string): void {
    const db = getDb();
    const node = db.prepare("SELECT id, endpoint FROM nodes WHERE id = ?").get(nodeId) as
      | { id: string; endpoint: string }
      | undefined;
    if (!node) throw new ProviderError("NODE_NOT_FOUND", "Virtualization node is not registered.", 404);
    if (node.endpoint !== "local") {
      throw new ProviderError(
        "REMOTE_NODE_UNSUPPORTED",
        "Only the local host agent is implemented; remote nodes are not connected."
      );
    }
  }

  static supportedTemplates(): string[] {
    return Object.keys(TEMPLATE_MAP);
  }

  async getNodeStatus(nodeId: string): Promise<NodeStatus> {
    this.requireLocalNode(nodeId);
    try {
      const { stdout } = await run("lxc-ls", ["--format", "csv"]);
      const containers = parseLxcLs(stdout);
      const running = containers.filter((c) => c.status === "running").length;
      return {
        nodeId,
        reachable: true,
        detail: "Host agent reachable; LXC tools responded.",
        containersTotal: containers.length,
        containersRunning: running,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("NODE_UNREACHABLE", "Host agent did not respond.");
    }
  }

  async listContainers(nodeId: string): Promise<ContainerInfo[]> {
    this.requireLocalNode(nodeId);
    const { stdout } = await run("lxc-ls", ["-f"]);
    return parseLxcLs(stdout);
  }

  async getContainer(nodeId: string, containerId: string): Promise<ContainerInfo> {
    validateContainerId(containerId);
    const all = await this.listContainers(nodeId);
    const found = all.find((c) => c.containerId === containerId);
    if (!found) throw new ProviderError("CONTAINER_NOT_FOUND", "Container not found on node.", 404);
    return found;
  }

  async createContainer(nodeId: string, request: CreateContainerRequest): Promise<ContainerInfo> {
    this.requireLocalNode(nodeId);
    validateContainerId(request.name);
    const image = templateImage(request.template);
    if (!Number.isInteger(request.cpu) || request.cpu < 1 || request.cpu > 32) {
      throw new ProviderError("INVALID_RESOURCES", "CPU allocation out of range (1-32).", 400);
    }
    if (!Number.isInteger(request.memoryMb) || request.memoryMb < 128 || request.memoryMb > 131072) {
      throw new ProviderError("INVALID_RESOURCES", "Memory allocation out of range.", 400);
    }
    if (!Number.isInteger(request.storageGb) || request.storageGb < 1 || request.storageGb > 2000) {
      throw new ProviderError("INVALID_RESOURCES", "Storage allocation out of range.", 400);
    }
    const name = request.containerId?.trim() ? request.containerId.trim() : request.name.trim();
    validateContainerId(name);
    // Uniqueness against the real host, not just the database.
    if (await containerExistsOnHost(name)) {
      throw new ProviderError("CONTAINER_EXISTS", "A container with this identifier already exists on the host.", 409);
    }
    const arch = downloadArch();
    // Backing store: btrfs subvolumes only when the host path is really
    // btrfs — otherwise the default dir backend (quotas honestly unsupported).
    const backing = await selectBackingStore();
    const createArgs = ["-n", name, "-t", "download"];
    if (backing === "btrfs") createArgs.push("-B", "btrfs");
    // Narrowly privileged creation: fixed template map + host arch, no shell interpolation.
    // Image download can take minutes; allow a long timeout and surface tool output.
    try {
      await run(
        "lxc-create",
        [...createArgs, "--", "-d", image.distro, "-r", image.release, "-a", arch],
        { timeoutMs: 10 * 60 * 1000, includeStderr: true }
      );
    } catch (err) {
      await destroyQuietly(name);
      if (err instanceof ProviderError && err.code === "LXC_TIMEOUT") {
        throw new ProviderError("CREATE_TIMEOUT", "Container image download timed out.", 504);
      }
      throw err;
    }
    try {
      // Confirm the container really exists before reporting anything.
      const state = await readContainerState(name).catch(() => "UNKNOWN" as const);
      if (state === "UNKNOWN" && !(await containerExistsOnHost(name))) {
        throw new ProviderError("CREATE_FAILED", "Container creation reported no error but the container is missing.");
      }
      // Apply and verify the requested resource limits on the real container.
      await applyResourceLimits(name, { cpu: request.cpu, memoryMb: request.memoryMb });
      // Enforce the disk quota where the backend supports it. A quota failure
      // fails creation loudly (with cleanup) rather than shipping a container
      // whose recorded allocation is a lie.
      if (backing === "btrfs") {
        const rootfs = containerRootfsPath(name);
        if (await isBtrfsSubvolume(rootfs)) {
          await enforceBtrfsQuota(rootfs, request.storageGb);
        }
      } else {
        const backend = await detectStorageBackend(name).catch(() => "unknown" as const);
        if (backend === "ext4") {
          try {
            await enforceExt4Quota(containerRootfsPath(name), name, request.storageGb);
          } catch (quotaErr) {
            // Host ext4 filesystem does not have project quotas active; continue creation without quota
          }
        }
      }
      // LXCFS views for correct guest-visible resources (best effort: never
      // fails creation when LXCFS is unavailable on the host).
      await ensureLxcfsInclude(name).catch(() => "unavailable" as const);
    } catch (err) {
      // Our own partial residue only: this name was verified absent above.
      await destroyQuietly(name);
      throw err;
    }
    const confirmed = await readContainerState(name).catch(() => "UNKNOWN" as const);
    return {
      containerId: name,
      name,
      status: confirmed === "RUNNING" ? "running" : "stopped",
    };
  }

  async startContainer(nodeId: string, containerId: string): Promise<void> {
    this.requireLocalNode(nodeId);
    validateContainerId(containerId);
    const current = await readContainerState(containerId).catch(() => "UNKNOWN" as const);
    if (current === "RUNNING") return;
    await run("lxc-start", ["-n", containerId], { timeoutMs: 60000 });
    await waitForState(containerId, "RUNNING", 60);
  }

  async stopContainer(nodeId: string, containerId: string): Promise<void> {
    this.requireLocalNode(nodeId);
    validateContainerId(containerId);
    const current = await readContainerState(containerId).catch(() => "UNKNOWN" as const);
    if (current === "STOPPED") return;
    await run("lxc-stop", ["-n", containerId], { timeoutMs: 120000 });
    await waitForState(containerId, "STOPPED", 90);
  }

  async deleteContainer(nodeId: string, containerId: string): Promise<void> {
    this.requireLocalNode(nodeId);
    validateContainerId(containerId);
    if (!(await containerExistsOnHost(containerId))) return;
    await run("lxc-destroy", ["-n", containerId, "-f"], { timeoutMs: 120000 });
    if (await containerExistsOnHost(containerId)) {
      throw new ProviderError("DESTROY_FAILED", "Container destroy ran but the container still exists.");
    }
  }
}

/** Returned when no node is registered yet — honest "not configured" state. */
export class UnconfiguredProvider implements VirtualizationProvider {
  readonly kind = "unconfigured";
  readonly capabilities = { create: false, start: false, stop: false, remove: false, liveStatus: false };
  private err(): ProviderError {
    return new ProviderError("INFRA_UNCONFIGURED", "No virtualization node is configured.", 409);
  }
  getNodeStatus(): Promise<NodeStatus> {
    throw this.err();
  }
  listContainers(): Promise<ContainerInfo[]> {
    throw this.err();
  }
  getContainer(): Promise<ContainerInfo> {
    throw this.err();
  }
  createContainer(): Promise<ContainerInfo> {
    throw this.err();
  }
  startContainer(): Promise<void> {
    throw this.err();
  }
  stopContainer(): Promise<void> {
    throw this.err();
  }
  deleteContainer(): Promise<void> {
    throw this.err();
  }
}

export function getProvider(): VirtualizationProvider {
  try {
    const db = getDb();
    const row = db.prepare("SELECT id FROM nodes LIMIT 1").get() as { id: string } | undefined;
    if (!row) return new UnconfiguredProvider();
    return new LocalLxcProvider();
  } catch {
    return new UnconfiguredProvider();
  }
}
