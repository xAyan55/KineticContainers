import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  containerConfigPath,
  containerExists,
  readContainerState,
  runLxc,
  validateContainerId,
  AgentError,
} from "./lxc.js";
import type { ContainerMetrics, EffectiveConfig, ResourceLimits } from "../types.js";

export type CgroupVersion = "v1" | "v2" | "unknown";

export function cgroupRoot(): string {
  return process.env.KCT_CGROUP_ROOT ?? "/sys/fs/cgroup";
}

export function detectCgroupVersion(): CgroupVersion {
  const root = cgroupRoot();
  try {
    if (fs.existsSync(path.join(root, "cgroup.controllers"))) return "v2";
    if (fs.existsSync(path.join(root, "memory"))) return "v1";
    if (fs.existsSync(path.join(root, "cpu"))) return "v1";
  } catch {
    // inaccessible
  }
  return "unknown";
}

export function hostCpuCount(): number {
  try {
    return os.cpus().length || 1;
  } catch {
    return 1;
  }
}

export function hostTotalMemoryMb(): number {
  try {
    return Math.round(os.totalmem() / (1024 * 1024));
  } catch {
    return 0;
  }
}

export function findContainerCgroup(containerId: string, maxDirs = 500): string | null {
  validateContainerId(containerId);
  const root = cgroupRoot();
  if (!fs.existsSync(root)) return null;

  const stack: string[] = [root];
  let inspected = 0;

  while (stack.length > 0 && inspected < maxDirs) {
    const cur = stack.pop()!;
    inspected++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(cur, e.name);
      if (e.name === containerId) return child;
      stack.push(child);
    }
  }
  return null;
}

export function readCgroupMetrics(containerId: string): { cpuSeconds: number | null; memoryMb: number | null } | null {
  const cgroupDir = findContainerCgroup(containerId);
  if (!cgroupDir) return null;

  let cpuSeconds: number | null = null;
  let memoryMb: number | null = null;

  // v2 memory
  const memCurrentPath = path.join(cgroupDir, "memory.current");
  if (fs.existsSync(memCurrentPath)) {
    try {
      const bytes = parseInt(fs.readFileSync(memCurrentPath, "utf8").trim(), 10);
      if (Number.isFinite(bytes)) memoryMb = Math.round(bytes / (1024 * 1024));
    } catch {
      // ignore
    }
  }

  // v2 cpu
  const cpuStatPath = path.join(cgroupDir, "cpu.stat");
  if (fs.existsSync(cpuStatPath)) {
    try {
      const text = fs.readFileSync(cpuStatPath, "utf8");
      for (const line of text.split("\n")) {
        if (line.startsWith("usage_usec")) {
          const usec = parseInt(line.split(/\s+/)[1], 10);
          if (Number.isFinite(usec)) cpuSeconds = Math.round(usec / 1000) / 1000;
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  // v1 fallback
  if (memoryMb === null) {
    const v1Mem = path.join(cgroupRoot(), "memory", "lxc", containerId, "memory.usage_in_bytes");
    if (fs.existsSync(v1Mem)) {
      try {
        const bytes = parseInt(fs.readFileSync(v1Mem, "utf8").trim(), 10);
        if (Number.isFinite(bytes)) memoryMb = Math.round(bytes / (1024 * 1024));
      } catch {
        // ignore
      }
    }
  }

  return { cpuSeconds, memoryMb };
}

export async function getContainerMetrics(containerId: string): Promise<ContainerMetrics> {
  validateContainerId(containerId);
  const sampledAt = new Date().toISOString();

  let cpuSeconds: number | null = null;
  let memoryMb: number | null = null;

  const cg = readCgroupMetrics(containerId);
  if (cg) {
    cpuSeconds = cg.cpuSeconds;
    memoryMb = cg.memoryMb;
  }

  if (cpuSeconds === null || memoryMb === null) {
    try {
      const { stdout } = await runLxc("lxc-info", ["-n", containerId]);
      for (const line of stdout.split("\n")) {
        const parts = line.split(":");
        const k = parts[0]?.trim().toLowerCase();
        const v = parts[1]?.trim();
        if (!v) continue;
        if (k.includes("cpu use") && cpuSeconds === null) {
          const val = parseFloat(v);
          if (Number.isFinite(val)) cpuSeconds = Math.round(val * 100) / 100;
        } else if (k.includes("memory use") && memoryMb === null) {
          const val = parseFloat(v);
          if (Number.isFinite(val)) {
            if (v.toLowerCase().includes("gib") || v.toLowerCase().includes("gb")) {
              memoryMb = Math.round(val * 1024);
            } else {
              memoryMb = Math.round(val);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    cpuSeconds,
    cpuPercent: null,
    memoryMb,
    memoryLimitMb: null,
    diskUsageGb: null,
    sampledAt,
  };
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

export function buildCgroupConfig(version: CgroupVersion, limits: ResourceLimits, hostCpus: number): string[] {
  const lines: string[] = [];
  const quota = Math.round(limits.cpu * 100000);
  const bytes = Math.round(limits.memoryMb * 1024 * 1024);

  if (version === "v1") {
    lines.push("lxc.cgroup.cpu.cfs_period_us = 100000");
    lines.push(`lxc.cgroup.cpu.cfs_quota_us = ${quota}`);
    lines.push(`lxc.cgroup.memory.limit_in_bytes = ${bytes}`);
  } else {
    lines.push(`lxc.cgroup2.cpu.max = ${quota} 100000`);
    lines.push(`lxc.cgroup2.memory.max = ${bytes}`);
  }

  // Shared CPU affinity set sized to the vCPU allocation for guest-visible enumeration
  const visible = hostCpus > 0 ? Math.max(1, Math.min(limits.cpu, hostCpus)) : 0;
  if (visible > 0) {
    const spec = visible === 1 ? "0" : `0-${visible - 1}`;
    lines.push(
      version === "v1" ? `lxc.cgroup.cpuset.cpus = ${spec}` : `lxc.cgroup2.cpuset.cpus = ${spec}`
    );
  }

  return lines;
}

export const LXCFS_INCLUDE_LINE = "lxc.include = /usr/share/lxc/config/common.conf.d/00-lxcfs.conf";

export function isLxcfsServing(): boolean {
  try {
    return fs.existsSync("/var/lib/lxcfs/proc/cpuinfo");
  } catch {
    return false;
  }
}

export async function ensureLxcfsInclude(containerId: string): Promise<"present" | "added" | "unavailable"> {
  const p = containerConfigPath(containerId);
  if (!fs.existsSync(p)) return "unavailable";
  const content = fs.readFileSync(p, "utf8");
  if (content.includes("00-lxcfs.conf")) return "present";
  if (!isLxcfsServing()) return "unavailable";

  const updated = `${content.trimEnd()}\n${LXCFS_INCLUDE_LINE}\n`;
  fs.writeFileSync(p, updated, "utf8");
  return "added";
}

export async function applyResourceLimits(
  containerId: string,
  limits: ResourceLimits
): Promise<EffectiveConfig> {
  validateContainerId(containerId);
  const cfgPath = containerConfigPath(containerId);
  if (!fs.existsSync(cfgPath)) {
    throw new AgentError("CONTAINER_NOT_FOUND", "Container config file does not exist.", 404);
  }

  const hostCpus = hostCpuCount();
  const cgVer = detectCgroupVersion();
  const newLines = buildCgroupConfig(cgVer, limits, hostCpus);

  let text = fs.readFileSync(cfgPath, "utf8");
  // Strip all managed cgroup keys before re-adding the new ones
  const filtered = text
    .split("\n")
    .filter((l) => {
      const key = l.split("=")[0]?.trim() ?? "";
      return !MANAGED_KEYS.includes(key);
    })
    .join("\n")
    .trimEnd();

  const finalContent = `${filtered}\n${newLines.join("\n")}\n`;
  fs.writeFileSync(cfgPath, finalContent, "utf8");

  // If container is running, attempt live cgroup updates
  const state = await readContainerState(containerId).catch(() => "UNKNOWN");
  if (state === "RUNNING") {
    const quota = Math.round(limits.cpu * 100000);
    const memBytes = String(Math.round(limits.memoryMb * 1024 * 1024));
    const visible = hostCpus > 0 ? Math.max(1, Math.min(limits.cpu, hostCpus)) : 0;
    const cpusetSpec = visible === 1 ? "0" : `0-${visible - 1}`;

    const liveKeys: [string, string][] =
      cgVer === "v1"
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

    for (const [key, value] of liveKeys) {
      await runLxc("lxc-cgroup", ["-n", containerId, key, value]).catch(() => undefined);
    }
  }

  return readEffectiveConfig(containerId);
}

export function parseCpusetCount(spec: string | null): number | null {
  if (!spec) return null;
  const parts = spec.trim().split(",");
  let count = 0;
  for (const part of parts) {
    const range = part.split("-");
    if (range.length === 2) {
      const a = parseInt(range[0], 10);
      const b = parseInt(range[1], 10);
      if (!isNaN(a) && !isNaN(b) && b >= a) count += b - a + 1;
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) count += 1;
    }
  }
  return count > 0 ? count : null;
}

export async function readEffectiveConfig(containerId: string): Promise<EffectiveConfig> {
  validateContainerId(containerId);
  const cfgPath = containerConfigPath(containerId);
  if (!fs.existsSync(cfgPath)) {
    throw new AgentError("CONTAINER_NOT_FOUND", "Container config file not found.", 404);
  }

  const text = fs.readFileSync(cfgPath, "utf8");
  let cpuLimit: number | null = null;
  let memoryMb: number | null = null;
  const lxcfsActive = text.includes("00-lxcfs.conf") && isLxcfsServing();
  const cgroupVersion = detectCgroupVersion();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...vParts] = line.split("=");
    const key = k.trim().toLowerCase();
    const val = vParts.join("=").trim();

    // CPU: prefer hard quota over cpuset count
    if (key === "lxc.cgroup.cpu.cfs_quota_us") {
      const q = parseInt(val, 10);
      if (Number.isFinite(q) && q > 0) {
        cpuLimit = Math.round((q / 100000) * 100) / 100;
      }
    } else if (key === "lxc.cgroup2.cpu.max") {
      const q = parseInt(val.split(/\s+/)[0], 10);
      if (Number.isFinite(q) && q > 0) {
        cpuLimit = Math.round((q / 100000) * 100) / 100;
      }
    } else if (cpuLimit === null && (key === "lxc.cgroup.cpuset.cpus" || key === "lxc.cgroup2.cpuset.cpus")) {
      // Fallback: use cpuset count if no hard quota is set
      cpuLimit = parseCpusetCount(val);
    } else if (key === "lxc.cgroup2.memory.max" || key === "lxc.cgroup.memory.limit_in_bytes") {
      const bytes = parseInt(val, 10);
      if (Number.isFinite(bytes) && bytes > 0) {
        memoryMb = Math.round(bytes / (1024 * 1024));
      }
    }
  }

  return {
    cpuLimit,
    memoryMb,
    lxcfsActive,
    cgroupVersion,
  };
}
