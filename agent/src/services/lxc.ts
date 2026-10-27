import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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
  "umount",
  "setquota",
  "repquota",
  "quotaon",
  "chattr",
  "lsattr",
  "resize2fs",
  "e2fsck",
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

  const results: ContainerInfo[] = [];
  for (const line of lines) {
    const parts = line.split(/[\s,]+/);
    if (parts.length === 0) continue;
    const name = (parts[0] ?? "").trim();
    if (!name || name.toUpperCase() === "NAME") continue;
    const rawState = (parts[1] ?? "").toLowerCase();

    let status: ContainerStatus = "unknown";
    if (rawState.includes("run")) status = "running";
    else if (rawState.includes("stop")) status = "stopped";
    else if (rawState.includes("start")) status = "starting";
    else if (rawState.includes("stopp")) status = "stopping";
    else if (rawState.includes("abort") || rawState.includes("fail")) status = "failed";

    const ipv4 = parts.find((p) => /^\d+\.\d+\.\d+\.\d+$/.test(p));

    results.push({
      containerId: name,
      name,
      status,
      ipv4,
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

export async function selectBackingStore(): Promise<"btrfs" | "loop" | "dir"> {
  const root = lxcRoot();
  try {
    const { stdout } = await runHostTool("df", ["-T", root]);
    const lines = stdout.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      if (parts[1]?.toLowerCase() === "btrfs") return "btrfs";
    }
  } catch {
    // fallback
  }
  if (process.platform === "linux") {
    return "loop";
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

const B64_CHARS = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function b64From24Bit(b2: number, b1: number, b0: number, size: number): string {
  let v = (b2 << 16) | (b1 << 8) | b0;
  let out = "";
  while (size-- > 0) {
    out += B64_CHARS[v & 0x3f];
    v >>= 6;
  }
  return out;
}

export function sha512Crypt(key: string, salt?: string, rounds = 5000): string {
  const cleanSalt = (
    salt ||
    crypto.randomBytes(12).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)
  ).slice(0, 16);
  const keyBuf = Buffer.from(key, "utf8");
  const saltBuf = Buffer.from(cleanSalt, "utf8");

  const ctxB = crypto.createHash("sha512");
  ctxB.update(keyBuf);
  ctxB.update(saltBuf);
  ctxB.update(keyBuf);
  const altResult = ctxB.digest();

  const ctxA = crypto.createHash("sha512");
  ctxA.update(keyBuf);
  ctxA.update(saltBuf);

  let cnt = keyBuf.length;
  while (cnt > 64) {
    ctxA.update(altResult);
    cnt -= 64;
  }
  ctxA.update(altResult.subarray(0, cnt));

  cnt = keyBuf.length;
  while (cnt > 0) {
    if ((cnt & 1) !== 0) {
      ctxA.update(altResult);
    } else {
      ctxA.update(keyBuf);
    }
    cnt >>= 1;
  }
  let pResult = ctxA.digest();

  const ctxP = crypto.createHash("sha512");
  for (let i = 0; i < keyBuf.length; i++) ctxP.update(keyBuf);
  const pBytes = ctxP.digest();
  const pSeq = Buffer.alloc(keyBuf.length);
  for (let i = 0; i < keyBuf.length; i++) pSeq[i] = pBytes[i % 64];

  const ctxS = crypto.createHash("sha512");
  for (let i = 0; i < 16 + pResult[0]; i++) ctxS.update(saltBuf);
  const sBytes = ctxS.digest();
  const sSeq = Buffer.alloc(cleanSalt.length);
  for (let i = 0; i < cleanSalt.length; i++) sSeq[i] = sBytes[i % 64];

  for (let i = 0; i < rounds; i++) {
    const ctx = crypto.createHash("sha512");
    if ((i & 1) !== 0) ctx.update(pSeq);
    else ctx.update(pResult);

    if (i % 3 !== 0) ctx.update(sSeq);
    if (i % 7 !== 0) ctx.update(pSeq);

    if ((i & 1) !== 0) ctx.update(pResult);
    else ctx.update(pSeq);

    pResult = ctx.digest();
  }

  let encoded = "";
  encoded += b64From24Bit(pResult[0], pResult[21], pResult[42], 4);
  encoded += b64From24Bit(pResult[22], pResult[43], pResult[1], 4);
  encoded += b64From24Bit(pResult[44], pResult[2], pResult[23], 4);
  encoded += b64From24Bit(pResult[3], pResult[24], pResult[45], 4);
  encoded += b64From24Bit(pResult[25], pResult[46], pResult[4], 4);
  encoded += b64From24Bit(pResult[47], pResult[5], pResult[26], 4);
  encoded += b64From24Bit(pResult[6], pResult[27], pResult[48], 4);
  encoded += b64From24Bit(pResult[28], pResult[49], pResult[7], 4);
  encoded += b64From24Bit(pResult[50], pResult[8], pResult[29], 4);
  encoded += b64From24Bit(pResult[9], pResult[30], pResult[51], 4);
  encoded += b64From24Bit(pResult[31], pResult[52], pResult[10], 4);
  encoded += b64From24Bit(pResult[53], pResult[11], pResult[32], 4);
  encoded += b64From24Bit(pResult[12], pResult[33], pResult[54], 4);
  encoded += b64From24Bit(pResult[34], pResult[55], pResult[13], 4);
  encoded += b64From24Bit(pResult[56], pResult[14], pResult[35], 4);
  encoded += b64From24Bit(pResult[15], pResult[36], pResult[57], 4);
  encoded += b64From24Bit(pResult[37], pResult[58], pResult[16], 4);
  encoded += b64From24Bit(pResult[59], pResult[17], pResult[38], 4);
  encoded += b64From24Bit(pResult[18], pResult[39], pResult[60], 4);
  encoded += b64From24Bit(pResult[40], pResult[61], pResult[19], 4);
  encoded += b64From24Bit(pResult[62], pResult[20], pResult[41], 4);
  encoded += b64From24Bit(0, 0, pResult[63], 2);

  return `$6$${cleanSalt}$${encoded}`;
}

export async function changeContainerRootPassword(containerId: string, password: string): Promise<void> {
  validateContainerId(containerId);
  if (!password || typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new AgentError("INVALID_PASSWORD", "Password must be between 8 and 128 characters.", 400);
  }
  if (!(await containerExists(containerId))) {
    throw new AgentError("NOT_FOUND", "Container does not exist on the host.", 404);
  }

  const hash = sha512Crypt(password);
  const days = Math.floor(Date.now() / 86400000);
  const rootfs = containerRootfsPath(containerId);
  const shadowPath = path.join(rootfs, "etc", "shadow");

  if (!fs.existsSync(shadowPath)) {
    throw new AgentError("SHADOW_NOT_FOUND", "Shadow database not found in container root filesystem.", 500);
  }

  try {
    const content = fs.readFileSync(shadowPath, "utf8");
    const lines = content.split("\n");
    let found = false;
    const newLines = lines.map((line) => {
      if (line.startsWith("root:")) {
        found = true;
        return `root:${hash}:${days}:0:99999:7:::`;
      }
      return line;
    });
    if (!found) {
      newLines.unshift(`root:${hash}:${days}:0:99999:7:::`);
    }
    const tmp = `${shadowPath}.kct_tmp_${Date.now()}`;
    fs.writeFileSync(tmp, newLines.join("\n"), { mode: 0o640 });
    fs.renameSync(tmp, shadowPath);
  } catch (err) {
    if (err instanceof AgentError) throw err;
    throw new AgentError(
      "PASSWORD_UPDATE_FAILED",
      `Failed to write shadow file: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }
}
