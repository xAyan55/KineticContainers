import fs from "node:fs";
import path from "node:path";
import {
  containerRootfsPath,
  runHostTool,
  runQuotaTool,
  validateContainerId,
  AgentError,
} from "./lxc.js";
import type { ContainerStorageInfo } from "../types.js";

export type StorageBackend = "btrfs" | "ext4" | "xfs" | "zfs" | "loop" | "dir" | "unknown";

export function isLoopContainer(containerId: string): boolean {
  try {
    validateContainerId(containerId);
    const rootdev = path.join("/var/lib/lxc", containerId, "rootdev");
    if (fs.existsSync(rootdev)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export async function detectStorageBackend(containerId: string): Promise<StorageBackend> {
  if (isLoopContainer(containerId)) return "loop";
  const rootfs = containerRootfsPath(containerId);
  try {
    const { stdout } = await runHostTool("df", ["-T", rootfs]);
    const lines = stdout.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const fsType = parts[1]?.toLowerCase();
      if (fsType === "btrfs") return "btrfs";
      if (fsType === "ext4") return "ext4";
      if (fsType === "xfs") return "xfs";
      if (fsType === "zfs") return "zfs";
      return "dir";
    }
  } catch {
    // fallback
  }
  return "unknown";
}

export async function isBtrfsSubvolume(rootfsPath: string): Promise<boolean> {
  try {
    const { stdout } = await runHostTool("btrfs", ["subvolume", "show", rootfsPath]);
    return !stdout.includes("ERROR:");
  } catch {
    return false;
  }
}

export async function getContainerDiskUsageGb(containerId: string): Promise<number | null> {
  const rootfs = containerRootfsPath(containerId);
  try {
    const { stdout } = await runHostTool("du", ["-s", "-BG", rootfs]);
    const match = /^(\d+)/.exec(stdout.trim());
    if (match) {
      return parseInt(match[1], 10);
    }
  } catch {
    // ignore
  }
  return null;
}

export async function enforceBtrfsQuota(rootfsPath: string, sizeGb: number): Promise<void> {
  try {
    await runHostTool("btrfs", ["quota", "enable", rootfsPath]).catch(() => undefined);
    await runHostTool("btrfs", ["qgroup", "limit", `${sizeGb}G`, rootfsPath]);
  } catch (err) {
    throw new AgentError("QUOTA_FAILED", `Failed to enforce btrfs quota: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
}

export async function readBtrfsQuotaGb(rootfsPath: string): Promise<number | null> {
  try {
    const { stdout } = await runHostTool("btrfs", ["qgroup", "show", "--raw", rootfsPath]);
    for (const line of stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const limitBytes = parseInt(parts[3], 10);
        if (Number.isFinite(limitBytes) && limitBytes > 0) {
          return Math.round(limitBytes / (1024 * 1024 * 1024));
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function inspectContainerStorage(containerId: string): Promise<ContainerStorageInfo> {
  validateContainerId(containerId);
  const rootfsPath = containerRootfsPath(containerId);
  const backend = await detectStorageBackend(containerId);
  const diskUsageGb = await getContainerDiskUsageGb(containerId);

  let quotaSupported = false;
  let quotaEnforcedGb: number | null = null;

  if (backend === "btrfs") {
    const isSubvol = await isBtrfsSubvolume(rootfsPath);
    if (isSubvol) {
      quotaSupported = true;
      quotaEnforcedGb = await readBtrfsQuotaGb(rootfsPath);
    }
  }

  return {
    backend,
    quotaSupported,
    quotaEnforcedGb,
    diskUsageGb,
    rootfsPath,
  };
}
