import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ContainerInfo, ContainerNetworkInfo, ContainerStatus, CreateContainerRequest } from "../types.js";

const TIMEOUT_MS = 15000;
const MAX_OUTPUT = 64 * 1024;

const LXC_ALLOWLIST = new Set([
  "lxc-ls",
  "lxc-info",
  "lxc-create",
  "lxc-start",
  "lxc-stop",
  "lxc-destroy",
  "lxc-checkconfig",
  "lxc-wait",
  "lxc-cgroup",
]);

const HOST_TOOL_ALLOWLIST = new Set([
  "df",
  "du",
  "btrfs",
  "systemd-detect-virt",
  "unshare",
  "ip",
]);

const QUOTA_TOOL_ALLOWLIST = new Set([
  "tune2fs",
  "findmnt",
  "mount",
  "setquota",
  "repquota",
  "quotaon",
  "chattr",
  "lsattr",
]);

export class AgentError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status = 500, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function validateContainerId(id: string): void {
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$/.test(id)) {
    throw new AgentError("INVALID_CONTAINER_ID", "Container identifier is invalid.", 400);
  }
}

export function lxcRoot(): string {
  return process.env.KCT_LXC_PATH ?? "/var/lib/lxc";
}

export function containerConfigPath(containerId: string): string {
  validateContainerId(containerId);
  return path.join(lxcRoot(), containerId, "config");
}

export function containerRootfsPath(containerId: string): string {
  validateContainerId(containerId);
  return path.join(lxcRoot(), containerId, "rootfs");
}

export function execStrict(
  cmd: string,
  args: string[],
  timeoutMs: number = TIMEOUT_MS,
  includeStderr = false
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { killed?: boolean }).code;
          const killed = (err as { killed?: boolean }).killed === true;
          if (code === "ENOENT") {
            reject(new AgentError("LXC_UNAVAILABLE", `Required tool is not installed: ${cmd}.`, 503));
            return;
          }
          if (killed) {
            reject(new AgentError("LXC_TIMEOUT", `Host command timed out: ${cmd}.`, 504));
            return;
          }
          let message = `Host command failed (${code ?? "error"}): ${cmd}.`;
          if (includeStderr) {
            const detail = String(stderr ?? "").trim().slice(0, 300);
            if (detail) message += ` ${detail}`;
          }
          reject(new AgentError("LXC_COMMAND_FAILED", message, 502));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

export function runLxc(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; includeStderr?: boolean } = {}
): Promise<{ stdout: string; stderr: string }> {
  if (!LXC_ALLOWLIST.has(cmd)) {
    return Promise.reject(new AgentError("COMMAND_NOT_ALLOWED", `Command is not allowlisted: ${cmd}.`, 400));
  }
  return execStrict(cmd, args, opts.timeoutMs ?? TIMEOUT_MS, opts.includeStderr ?? false);
}

export function runHostTool(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; includeStderr?: boolean } = {}
): Promise<{ stdout: string; stderr: string }> {
  if (!HOST_TOOL_ALLOWLIST.has(cmd)) {
    return Promise.reject(new AgentError("COMMAND_NOT_ALLOWED", `Host tool is not allowlisted: ${cmd}.`, 400));
  }
  return execStrict(cmd, args, opts.timeoutMs ?? TIMEOUT_MS, opts.includeStderr ?? false);
}

export function runQuotaTool(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; includeStderr?: boolean } = {}
): Promise<{ stdout: string; stderr: string }> {
  if (!QUOTA_TOOL_ALLOWLIST.has(cmd)) {
    return Promise.reject(new AgentError("COMMAND_NOT_ALLOWED", `Quota tool is not allowlisted: ${cmd}.`, 400));
  }
  return execStrict(cmd, args, opts.timeoutMs ?? TIMEOUT_MS, opts.includeStderr ?? false);
}

export async function containerExists(containerId: string): Promise<boolean> {
  validateContainerId(containerId);
  try {
    const { stdout } = await runLxc("lxc-ls", ["-1"]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(containerId);
  } catch (err) {
    if (err instanceof AgentError && err.code === "LXC_UNAVAILABLE") throw err;
    return false;
  }
}

export function parseLxcLs(output: string): ContainerInfo[] {
  const lines = output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const headers = lines[0].toLowerCase().split(/\s{2,}/);
  const nameIdx = headers.findIndex((h) => h.includes("name"));
  const stateIdx = headers.findIndex((h) => h.includes("state"));
  const ipv4Idx = headers.findIndex((h) => h.includes("ipv4"));

  const results: ContainerInfo[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s{2,}/);
    const rawName = nameIdx >= 0 ? parts[nameIdx]?.trim() : parts[0]?.trim();
    if (!rawName) continue;
    const rawState = stateIdx >= 0 ? parts[stateIdx]?.trim()?.toLowerCase() : parts[1]?.trim()?.toLowerCase();
    const rawIpv4 = ipv4Idx >= 0 ? parts[ipv4Idx]?.trim() : undefined;

    let status: ContainerStatus = "unknown";
    if (rawState === "running") status = "running";
    else if (rawState === "stopped") status = "stopped";
    else if (rawState === "starting") status = "starting";
    else if (rawState === "stopping") status = "stopping";
    else if (rawState === "aborted" || rawState === "failed") status = "failed";

    results.push({
      containerId: rawName,
      name: rawName,
      status,
      ipv4: rawIpv4 && rawIpv4 !== "-" ? rawIpv4.split(",")[0].trim() : undefined,
    });
  }
  return results;
}

export async function listAllContainers(): Promise<ContainerInfo[]> {
  try {
    const { stdout } = await runLxc("lxc-ls", ["-f"]);
    return parseLxcLs(stdout);
  } catch (err) {
    if (err instanceof AgentError && err.code === "LXC_UNAVAILABLE") throw err;
    // Fallback to simple lxc-ls -1
    const { stdout } = await runLxc("lxc-ls", ["-1"]);
    const names = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const infos: ContainerInfo[] = [];
    for (const name of names) {
      const state = await readContainerState(name).catch(() => "unknown");
      infos.push({
        containerId: name,
        name,
        status: state === "RUNNING" ? "running" : state === "STOPPED" ? "stopped" : "unknown",
      });
    }
    return infos;
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

export async function readContainerState(containerId: string): Promise<LxcState> {
  validateContainerId(containerId);
  try {
    const { stdout } = await runLxc("lxc-info", ["-n", containerId, "-s"]);
    for (const line of stdout.split("\n")) {
      const parts = line.split(":");
      if (parts[0]?.trim().toLowerCase() === "state") {
        const val = parts[1]?.trim().toUpperCase();
        if (
          val === "RUNNING" ||
          val === "STOPPED" ||
          val === "STARTING" ||
          val === "STOPPING" ||
          val === "FREEZING" ||
          val === "FROZEN" ||
          val === "ABORTING"
        ) {
          return val as LxcState;
        }
      }
    }
    return "UNKNOWN";
  } catch (err) {
    if (err instanceof AgentError && err.code === "LXC_UNAVAILABLE") throw err;
    return "UNKNOWN";
  }
}

export async function waitForState(containerId: string, desired: LxcState, timeoutSec = 60): Promise<void> {
  try {
    await runLxc("lxc-wait", ["-n", containerId, "-s", desired, "-t", String(timeoutSec)], {
      timeoutMs: (timeoutSec + 5) * 1000,
    });
  } catch {
    const start = Date.now();
    while (Date.now() - start < timeoutSec * 1000) {
      const state = await readContainerState(containerId).catch(() => "UNKNOWN");
      if (state === desired) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new AgentError(
      "STATE_TIMEOUT",
      `Container did not reach state ${desired} within ${timeoutSec}s.`,
      504
    );
  }
}

export function parseLxcInfo(output: string): {
  state: LxcState;
  ipv4?: string;
  interfaces: { name: string; hwaddr: string; inet?: string }[];
} {
  let state: LxcState = "UNKNOWN";
  const interfaces: { name: string; hwaddr: string; inet?: string }[] = [];
  let currentIf: { name: string; hwaddr: string; inet?: string } | null = null;
  let primaryIpv4: string | undefined;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();

    if (k === "state") {
      const upper = v.toUpperCase();
      if (
        upper === "RUNNING" ||
        upper === "STOPPED" ||
        upper === "STARTING" ||
        upper === "STOPPING" ||
        upper === "FREEZING" ||
        upper === "FROZEN" ||
        upper === "ABORTING"
      ) {
        state = upper as LxcState;
      }
    } else if (k === "link") {
      if (currentIf) interfaces.push(currentIf);
      currentIf = { name: v, hwaddr: "" };
    } else if (k === "hwaddr" && currentIf) {
      currentIf.hwaddr = v;
    } else if (k === "inet" || k === "ip") {
      const cleanIp = v.split("/")[0].trim();
      if (cleanIp && !cleanIp.startsWith("127.")) {
        if (!primaryIpv4) primaryIpv4 = cleanIp;
        if (currentIf) currentIf.inet = cleanIp;
      }
    } else if (k === "ipv4") {
      const cleanIp = v.split("/")[0].trim();
      if (cleanIp && !cleanIp.startsWith("127.") && !primaryIpv4) {
        primaryIpv4 = cleanIp;
      }
    }
  }
  if (currentIf) interfaces.push(currentIf);

  return { state, ipv4: primaryIpv4, interfaces };
}

export async function getContainerNetwork(containerId: string): Promise<ContainerNetworkInfo> {
  validateContainerId(containerId);
  try {
    const { stdout } = await runLxc("lxc-info", ["-n", containerId, "-i"]);
    const parsed = parseLxcInfo(stdout);
    return {
      interfaces: parsed.interfaces,
      primaryIpv4: parsed.ipv4 ?? null,
    };
  } catch (err) {
    if (err instanceof AgentError && err.code === "LXC_UNAVAILABLE") throw err;
    return { interfaces: [], primaryIpv4: null };
  }
}

const TEMPLATE_MAP: Record<string, { distro: string; release: string }> = {
  "ubuntu-22.04": { distro: "ubuntu", release: "jammy" },
  "ubuntu-24.04": { distro: "ubuntu", release: "noble" },
  "debian-12": { distro: "debian", release: "bookworm" },
  "alpine-3.20": { distro: "alpine", release: "3.20" },
};

export function supportedTemplates(): string[] {
  return Object.keys(TEMPLATE_MAP);
}

export function templateImage(template: string): { distro: string; release: string } {
  const img = TEMPLATE_MAP[template];
  if (!img) {
    throw new AgentError("UNSUPPORTED_TEMPLATE", `Template '${template}' is not supported.`, 400);
  }
  return img;
}

export function downloadArch(arch: string = os.arch()): string {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new AgentError("UNSUPPORTED_ARCH", `Host CPU architecture is not supported: ${arch}.`, 400);
}

export async function selectBackingStore(): Promise<"btrfs" | "dir"> {
  const root = lxcRoot();
  try {
    const { stdout } = await runHostTool("df", ["-T", root]);
    const lines = stdout.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      if (parts[1]?.toLowerCase() === "btrfs") return "btrfs";
    }
  } catch {
    // fallback to dir
  }
  return "dir";
}

export async function destroyQuietly(containerId: string): Promise<void> {
  try {
    if (await containerExists(containerId)) {
      await runLxc("lxc-destroy", ["-n", containerId, "-f"], { timeoutMs: 120000 });
    }
  } catch {
    // best-effort cleanup
  }
}
