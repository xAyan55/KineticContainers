import type {
  ContainerInfo,
  CreateContainerRequest,
  NodeStatus,
  VirtualizationProvider,
} from "./provider.js";
import { ProviderError } from "./provider.js";
import { parseLxcLs, runLxc } from "./host.js";
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
      cpuSeconds = Number.isFinite(n) ? n : null;
      continue;
    }
    m = line.match(/^Memory use:\s*([\d.]+)\s*([KMG]iB)/i);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2].toUpperCase();
      if (Number.isFinite(n)) {
        const factor = unit === "GIB" ? 1024 : unit === "MIB" ? 1 : unit === "KIB" ? 1 / 1024 : 0;
        memoryMb = factor > 0 ? Math.round(n * factor * 10) / 10 : null;
      }
    }
  }
  return { cpuSeconds, memoryMb };
}

export async function getContainerMetrics(
  containerId: string
): Promise<{ cpuSeconds: number | null; memoryMb: number | null }> {
  validateContainerId(containerId);
  const { stdout } = await run("lxc-info", ["-n", containerId]);
  return parseLxcMetrics(stdout);
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

/**
 * Build the exact config lines that enforce CPU (hard quota) and memory.
 * Pure and unit-tested; never invents storage quotas (dir backend has none).
 */
export function buildCgroupConfig(version: CgroupVersion, limits: ResourceLimits): string[] {
  const bytes = Math.round(limits.memoryMb * 1024 * 1024);
  const quota = Math.round(limits.cpu * 100000);
  if (version === "v1") {
    return [
      "lxc.cgroup.cpu.cfs_period_us = 100000",
      `lxc.cgroup.cpu.cfs_quota_us = ${quota}`,
      `lxc.cgroup.memory.limit_in_bytes = ${bytes}`,
    ];
  }
  return [`lxc.cgroup2.cpu.max = ${quota} 100000`, `lxc.cgroup2.memory.max = ${bytes}`];
}

/** Config keys managed by KineticCT (both cgroup generations). */
const MANAGED_KEYS = [
  "lxc.cgroup.cpu.cfs_period_us",
  "lxc.cgroup.cpu.cfs_quota_us",
  "lxc.cgroup.memory.limit_in_bytes",
  "lxc.cgroup2.cpu.max",
  "lxc.cgroup2.memory.max",
];

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
): { cpu: number | null; memoryMb: number | null } {
  const get = (key: string): string | null => {
    const m = configText.match(new RegExp(`^${key.replace(/\./g, "\\.")}\\s*=\\s*(\\S+)`, "m"));
    return m ? m[1] : null;
  };
  let cpu: number | null = null;
  let memoryMb: number | null = null;
  if (version === "v1") {
    const quota = get("lxc.cgroup.cpu.cfs_quota_us");
    const mem = get("lxc.cgroup.memory.limit_in_bytes");
    if (quota !== null && /^-?\d+$/.test(quota)) {
      const q = Number(quota);
      cpu = q > 0 ? Math.round((q / 100000) * 100) / 100 : null;
    }
    if (mem !== null && /^\d+$/.test(mem)) memoryMb = Math.round(Number(mem) / (1024 * 1024));
  } else {
    const max = get("lxc.cgroup2.cpu.max");
    const mem = get("lxc.cgroup2.memory.max");
    if (max !== null) {
      const q = Number(max.split(/\s+/)[0]);
      cpu = Number.isFinite(q) && q > 0 ? Math.round((q / 100000) * 100) / 100 : null;
    }
    if (mem !== null && /^\d+$/.test(mem)) memoryMb = Math.round(Number(mem) / (1024 * 1024));
  }
  return { cpu, memoryMb };
}

export interface EffectiveConfig {
  cpu: number | null;
  memoryMb: number | null;
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
  const { cpu, memoryMb } = parseEffectiveLimits(text, version);
  return {
    cpu,
    memoryMb,
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
  const lines = buildCgroupConfig(version, limits);
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
  const liveKeys: [string, string][] =
    version === "v1"
      ? [
          ["cpu.cfs_period_us", "100000"],
          ["cpu.cfs_quota_us", String(Math.round(limits.cpu * 100000))],
          ["memory.limit_in_bytes", String(Math.round(limits.memoryMb * 1024 * 1024))],
        ]
      : [
          ["cpu.max", `${Math.round(limits.cpu * 100000)} 100000`],
          ["memory.max", String(Math.round(limits.memoryMb * 1024 * 1024))],
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
    // Narrowly privileged creation: fixed template map + host arch, no shell interpolation.
    // Image download can take minutes; allow a long timeout and surface tool output.
    try {
      await run(
        "lxc-create",
        ["-n", name, "-t", "download", "--", "-d", image.distro, "-r", image.release, "-a", arch],
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
