import fs from "node:fs";
import {
  containerConfigPath,
  containerRootfsPath,
  validateContainerId,
  AgentError,
} from "./lxc.js";
import {
  applyResourceLimits,
  ensureLxcfsInclude,
  isLxcfsServing,
  readEffectiveConfig,
} from "./cgroup.js";
import {
  detectStorageBackend,
  enforceBtrfsQuota,
  isBtrfsSubvolume,
  readBtrfsQuotaGb,
} from "./storage.js";
import type { RepairCheck, RepairPlan, RepairReport, ResourceLimits } from "../types.js";

export async function planRepair(containerId: string, target: ResourceLimits): Promise<RepairPlan> {
  validateContainerId(containerId);
  const checks: { check: string; status: "ok" | "needed" | "unsupported"; detail: string }[] = [];

  const effective = await readEffectiveConfig(containerId);
  if (target.cpu && effective.cpuLimit !== target.cpu) {
    checks.push({
      check: "cpu_limits",
      status: "needed",
      detail: `Configured for ${target.cpu} CPU(s); effective limit is ${effective.cpuLimit ?? "unbounded"}.`,
    });
  } else {
    checks.push({ check: "cpu_limits", status: "ok", detail: "CPU allocation matches configuration." });
  }

  if (target.memoryMb && effective.memoryMb !== target.memoryMb) {
    checks.push({
      check: "memory_limits",
      status: "needed",
      detail: `Configured for ${target.memoryMb} MB; effective limit is ${effective.memoryMb ?? "unbounded"}.`,
    });
  } else {
    checks.push({ check: "memory_limits", status: "ok", detail: "Memory allocation matches configuration." });
  }

  if (isLxcfsServing()) {
    if (!effective.lxcfsActive) {
      checks.push({
        check: "lxcfs_include",
        status: "needed",
        detail: "LXCFS is running on the host but this container config is missing the lxcfs include.",
      });
    } else {
      checks.push({ check: "lxcfs_include", status: "ok", detail: "LXCFS include is active." });
    }
  } else {
    checks.push({ check: "lxcfs_include", status: "unsupported", detail: "LXCFS is not active on this host." });
  }

  const backend = await detectStorageBackend(containerId);
  const rootfs = containerRootfsPath(containerId);
  if (backend === "btrfs" && (await isBtrfsSubvolume(rootfs))) {
    const quota = await readBtrfsQuotaGb(rootfs);
    if (target.storageGb && quota !== target.storageGb) {
      checks.push({
        check: "btrfs_quota",
        status: "needed",
        detail: `Configured for ${target.storageGb} GB; effective quota is ${quota ?? "disabled"}.`,
      });
    } else {
      checks.push({ check: "btrfs_quota", status: "ok", detail: "Storage quota matches configuration." });
    }
  } else {
    checks.push({ check: "storage_quota", status: "unsupported", detail: `Quotas unsupported on ${backend} backend.` });
  }

  return { containerId, checks };
}

export async function applyRepair(containerId: string, target: ResourceLimits): Promise<RepairReport> {
  validateContainerId(containerId);
  const checks: RepairCheck[] = [];

  // Backup config once
  const cfgPath = containerConfigPath(containerId);
  const backupPath = `${cfgPath}.repair-backup`;
  if (fs.existsSync(cfgPath) && !fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(cfgPath, backupPath);
    } catch {
      // ignore
    }
  }

  try {
    await applyResourceLimits(containerId, { cpu: target.cpu, memoryMb: target.memoryMb });
    checks.push({ check: "resource_limits", status: "fixed", message: "Resource limits reapplied to container config." });
  } catch (err) {
    checks.push({
      check: "resource_limits",
      status: "failed",
      message: `Failed to reapply limits: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    const lxcfsRes = await ensureLxcfsInclude(containerId);
    if (lxcfsRes === "added") {
      checks.push({ check: "lxcfs_include", status: "fixed", message: "Added LXCFS include to container config." });
    } else if (lxcfsRes === "present") {
      checks.push({ check: "lxcfs_include", status: "ok", message: "LXCFS include already present." });
    } else {
      checks.push({ check: "lxcfs_include", status: "unsupported", message: "LXCFS is not running on host." });
    }
  } catch (err) {
    checks.push({
      check: "lxcfs_include",
      status: "failed",
      message: `Failed to update LXCFS include: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const backend = await detectStorageBackend(containerId);
  const rootfs = containerRootfsPath(containerId);
  if (backend === "btrfs" && (await isBtrfsSubvolume(rootfs))) {
    try {
      if (target.storageGb) {
        await enforceBtrfsQuota(rootfs, target.storageGb);
        checks.push({ check: "btrfs_quota", status: "fixed", message: `Enforced btrfs quota of ${target.storageGb} GB.` });
      }
    } catch (err) {
      checks.push({
        check: "btrfs_quota",
        status: "failed",
        message: `Failed to enforce btrfs quota: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { containerId, checks };
}
