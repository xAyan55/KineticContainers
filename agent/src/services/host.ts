import os from "node:os";
import fs from "node:fs";
import { execStrict, runHostTool, runLxc, AgentError } from "./lxc.js";
import { detectCgroupVersion, isLxcfsServing } from "./cgroup.js";
import type { HostCapabilities, HostInfo, NodeHealthCheck } from "../types.js";

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function safeRead(filePath: string, maxBytes = 4096): string | null {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, maxBytes);
  } catch {
    return null;
  }
}

function safeExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function parseOsRelease(): { name: string | null; version: string | null } {
  const content = safeRead("/etc/os-release") ?? safeRead("/usr/lib/os-release");
  if (!content) return { name: null, version: null };

  let name: string | null = null;
  let version: string | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("PRETTY_NAME=")) {
      name = trimmed.slice(12).replace(/^["']|["']$/g, "");
    } else if (trimmed.startsWith("VERSION_ID=") && !version) {
      version = trimmed.slice(11).replace(/^["']|["']$/g, "");
    }
  }
  return { name, version };
}

export function detectNestedGuest(input: { dockerenv: boolean; virt: string | null; cgroup: string | null }): string | null {
  if (input.dockerenv) return "docker";
  if (input.virt) {
    const v = input.virt.toLowerCase();
    if (v === "lxc" || v === "lxc-libvirt") return "lxc";
    if (v === "docker") return "docker";
    if (v === "podman") return "podman";
    if (v === "openvz") return "openvz";
    if (v === "wsl") return "wsl";
    if (v !== "none") return v;
  }
  if (input.cgroup) {
    if (input.cgroup.includes("docker")) return "docker";
    if (input.cgroup.includes("lxc")) return "lxc";
  }
  return null;
}

export function isRestrictedGuest(guest: string | null): boolean {
  if (!guest) return false;
  const lower = guest.toLowerCase();
  return lower === "docker" || lower === "openvz" || lower === "wsl";
}

export async function readRootFs(): Promise<{ totalGb: number; usedGb: number; availGb: number } | null> {
  try {
    const { stdout } = await runHostTool("df", ["-BG", "/"]);
    const lines = stdout.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const total = parseInt(parts[1], 10);
      const used = parseInt(parts[2], 10);
      const avail = parseInt(parts[3], 10);
      if (!isNaN(total) && !isNaN(used) && !isNaN(avail)) {
        return { totalGb: total, usedGb: used, availGb: avail };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function sampleCpuPercent(): Promise<number | null> {
  const readCpu = (): { idle: number; total: number } => {
    try {
      const text = fs.readFileSync("/proc/stat", "utf8");
      const first = text.split("\n")[0];
      const parts = first.split(/\s+/).slice(1).map(Number);
      const idle = parts[3] + (parts[4] || 0);
      const total = parts.reduce((a, b) => a + b, 0);
      return { idle, total };
    } catch {
      return { idle: 0, total: 0 };
    }
  };

  const a = readCpu();
  if (a.total === 0) return null;
  await new Promise((r) => setTimeout(r, 100));
  const b = readCpu();
  const totalDiff = b.total - a.total;
  const idleDiff = b.idle - a.idle;
  if (totalDiff <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((totalDiff - idleDiff) / totalDiff) * 100)));
}

export async function getHostInfo(): Promise<HostInfo> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = (() => {
    try {
      return os.cpus();
    } catch {
      return [];
    }
  })();
  const osRelease = parseOsRelease();
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
        return os.hostname();
      } catch {
        return "unknown";
      }
    })(),
    platform: os.platform(),
    osName: osRelease.name,
    osVersion: osRelease.version,
    kernel: (() => {
      try {
        return os.release();
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

export async function getHostCapabilities(): Promise<HostCapabilities> {
  let lxcInstalled = false;
  let lxcVersion: string | null = null;
  try {
    const { stdout } = await runLxc("lxc-ls", ["--version"]);
    lxcInstalled = true;
    const match = /(\d+\.\d+(\.\d+)?)/.exec(stdout);
    lxcVersion = match ? match[1] : stdout.trim().slice(0, 32);
  } catch {
    lxcInstalled = false;
    lxcVersion = null;
  }

  let virt: string | null = null;
  try {
    const { stdout } = await execStrict("systemd-detect-virt", []);
    virt = stdout.trim().slice(0, 32) || null;
  } catch {
    virt = null;
  }

  const cgroupText = safeRead("/proc/1/cgroup") ?? safeRead("/proc/self/cgroup");
  const nestedGuest = detectNestedGuest({
    dockerenv: safeExists("/.dockerenv"),
    virt,
    cgroup: cgroupText,
  });

  let userNamespaces: boolean | null = null;
  try {
    await execStrict("unshare", ["-U", "true"]);
    userNamespaces = true;
  } catch (err) {
    userNamespaces = err instanceof AgentError && err.code === "LXC_UNAVAILABLE" ? null : false;
  }

  const cgVer = detectCgroupVersion();
  const cgroupType: "v1" | "v2" | "hybrid" | "none" =
    cgVer === "v2" ? "v2" : cgVer === "v1" ? "v1" : "none";

  let bridgePresent: boolean | null = null;
  try {
    await execStrict("ip", ["-o", "link", "show", "lxcbr0"]);
    bridgePresent = true;
  } catch {
    bridgePresent = false;
  }

  const ipfwd = safeRead("/proc/sys/net/ipv4/ip_forward", 16)?.trim() ?? null;
  const runtimeUid = typeof process.geteuid === "function" ? process.geteuid() : null;

  return {
    lxcInstalled,
    lxcVersion,
    nestedGuest,
    restrictedGuest: isRestrictedGuest(nestedGuest),
    userNamespaces,
    cgroup: cgroupType,
    bridgePresent,
    ipForwarding: ipfwd === "1" ? true : ipfwd === "0" ? false : null,
    runtimeUid,
    lxcfsActive: isLxcfsServing(),
  };
}

export async function getHostCapacity(): Promise<{ memoryAvailableMb: number; storageAvailableGb: number; cpuCount: number }> {
  const host = await getHostInfo();
  return {
    memoryAvailableMb: host.memoryFreeMb,
    storageAvailableGb: host.rootAvailGb ?? 0,
    cpuCount: host.cpuCount,
  };
}

export async function collectHealthCheck(containersTotal: number | null, containersRunning: number | null): Promise<NodeHealthCheck> {
  const checkedAt = new Date().toISOString();
  let host: HostInfo | null = null;
  let caps: HostCapabilities | null = null;

  try {
    host = await getHostInfo();
  } catch {
    host = null;
  }

  try {
    caps = await getHostCapabilities();
  } catch {
    caps = null;
  }

  const lxcInstalled = caps?.lxcInstalled ?? false;
  const commandsOk = lxcInstalled;
  const permissionsOk = caps?.runtimeUid === 0 || caps?.userNamespaces === true || (caps?.runtimeUid !== null);
  const inventoryOk = containersTotal !== null;
  const resourcesOk = (host?.memoryTotalMb ?? 0) > 0;

  const ok = lxcInstalled && commandsOk;
  let status: "online" | "unconfigured" | "error" | "unavailable" = "online";
  let detail = "Host agent reachable; LXC tools responded.";

  if (!lxcInstalled) {
    status = "unconfigured";
    detail = "LXC is not installed on this host. Install LXC tooling to manage containers.";
  } else if (caps?.restrictedGuest) {
    status = "error";
    detail = `Host is running inside a restricted container (${caps.nestedGuest}) without nested LXC privileges.`;
  }

  return {
    status,
    ok,
    checkedAt,
    detail,
    checks: {
      lxcInstalled,
      commandsOk,
      permissionsOk,
      inventoryOk,
      resourcesOk,
    },
    host,
    hostCapabilities: caps,
    containersTotal,
    containersRunning,
  };
}
