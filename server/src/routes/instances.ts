import { Router, type Response } from "express";
import { z } from "zod";
import { getDb, nowIso } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  applyResourceLimits,
  containerExistsOnHost,
  containerRootfsPath,
  enforceBtrfsQuota,
  enforceExt4Quota,
  getContainerMetrics,
  getContainerNetwork,
  getContainerStorage,
  isBtrfsSubvolume,
  isLxcfsActiveForContainer,
  planInstanceRepair,
  readContainerState,
  readEffectiveConfig,
  repairInstance,
  RESOURCE_MODEL,
  LocalLxcProvider,
} from "../services/virtualization/localAgent.js";
import { checkConsoleRunnable } from "../services/virtualization/console.js";
import { ProviderError, type ContainerMetrics } from "../services/virtualization/provider.js";
import { getProviderForNode } from "../services/virtualization/providerRegistry.js";

export const instancesRouter = Router();
instancesRouter.use(requireAuth);

export type InstanceRow = Record<string, unknown>;

export function toPublic(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    container_id: row.container_id,
    node_id: row.node_id,
    node_name: (row as { node_name?: string }).node_name ?? null,
    status: row.status,
    cpu: row.cpu,
    memory_mb: row.memory_mb,
    storage_gb: row.storage_gb,
    template: row.template,
    ip_address: row.ip_address,
    // Administrator note (Proxmox-style): visible to everyone who can see the
    // instance, editable by administrators only.
    notes: row.notes ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Owner-scoped lookup. Unknown ids and other users' instances are both 404. */
function getOwnedInstance(db: ReturnType<typeof getDb>, instanceId: string, userId: string): InstanceRow | undefined {
  return db
    .prepare(
      `SELECT i.*, n.name AS node_name FROM instances i LEFT JOIN nodes n ON n.id = i.node_id WHERE i.id = ? AND i.owner_id = ?`
    )
    .get(instanceId, userId) as InstanceRow | undefined;
}

/**
 * Use-and-manage lookup: administrators see every instance, ordinary users
 * see only their own. Unknown ids and (for users) foreign instances are 404.
 */
export function getManagedInstance(
  db: ReturnType<typeof getDb>,
  instanceId: string,
  user: { id: string; role: string }
): InstanceRow | undefined {
  if (user.role === "admin") {
    return db
      .prepare(
        `SELECT i.*, n.name AS node_name FROM instances i LEFT JOIN nodes n ON n.id = i.node_id WHERE i.id = ?`
      )
      .get(instanceId) as InstanceRow | undefined;
  }
  return getOwnedInstance(db, instanceId, user.id);
}

function forbidden(res: Response): void {
  res.status(403).json({ error: { code: "FORBIDDEN", message: "Administrator access required." } });
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Instance not found." } });
}

function providerError(res: Response, err: unknown): void {
  if (err instanceof ProviderError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  res.status(502).json({ error: { code: "PROVIDER_ERROR", message: "Infrastructure operation failed." } });
}

instancesRouter.get("/", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT i.*, n.name AS node_name FROM instances i LEFT JOIN nodes n ON n.id = i.node_id WHERE i.owner_id = ? ORDER BY i.created_at DESC`
    )
    .all(req.user!.id) as Record<string, unknown>[];
  res.json({ data: { instances: rows.map(toPublic) } });
});

instancesRouter.get("/:id", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  // Reconcile with the real host: never present stale DB status as truth.
  const live = await readLiveState(row);
  reconcileStoredStatus(db, row, live);
  res.json({ data: { instance: toPublic(row), live } });
});

export interface LiveState {
  /** true = on host, false = checked and absent, null = could not check. */
  exists: boolean | null;
  status: string | null;
  checkedAt: string;
  error: string | null;
}

/**
 * Persist verified host truth over the stored status. Suspension is an
 * administrative hold, not a host fact, so it is never overwritten here —
 * only the suspend/unsuspend endpoints change it.
 */
export function reconcileStoredStatus(
  db: ReturnType<typeof getDb>,
  row: InstanceRow,
  live: LiveState
): boolean {
  if (row.status === "suspended") return false;
  if (live.exists && (live.status === "running" || live.status === "stopped") && live.status !== row.status) {
    db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run(
      live.status,
      nowIso(),
      row.id as string
    );
    row.status = live.status;
    row.updated_at = nowIso();
    return true;
  }
  return false;
}

async function readLiveState(row: InstanceRow): Promise<LiveState> {
  const checkedAt = new Date().toISOString();
  const nodeId = row.node_id as string | null;
  const containerId = row.container_id as string | null;
  if (!nodeId || !containerId) {
    return { exists: false, status: null, checkedAt, error: "Instance is not attached to a configured node." };
  }
  const provider = getProviderForNode(nodeId);
  let exists: boolean;
  try {
    exists = await provider.containerExists(nodeId, containerId);
  } catch (err) {
    // The inventory itself is unreadable (e.g. no LXC tooling): unknown, not absent.
    const message = err instanceof ProviderError ? err.message : "Live state could not be read.";
    return { exists: null, status: null, checkedAt, error: message };
  }
  if (!exists) {
    return { exists: false, status: null, checkedAt, error: "No matching container exists on the host." };
  }
  try {
    const state = await provider.readContainerState(nodeId, containerId);
    const status = state === "RUNNING" ? "running" : state === "STOPPED" ? "stopped" : state.toLowerCase();
    return { exists: true, status, checkedAt, error: null };
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "Live state could not be read.";
    return { exists: true, status: null, checkedAt, error: message };
  }
}

/** Live status + metrics, reconciled honestly (no fake data when unreadable). */
instancesRouter.get("/:id/live", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  const live = await readLiveState(row);
  let metrics: ContainerMetrics | null = null;
  if (live.exists && live.status === "running") {
    try {
      const provider = getProviderForNode(row.node_id as string);
      metrics = await provider.getContainerMetrics(row.node_id as string, row.container_id as string);
    } catch {
      metrics = null;
    }
  }
  res.json({ data: { live, metrics } });
});

/** Live network facts from the host. */
instancesRouter.get("/:id/network", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  try {
    const provider = getProviderForNode(row.node_id as string);
    const network = await provider.getContainerNetwork(row.node_id as string, row.container_id as string);
    res.json({ data: { network, checkedAt: new Date().toISOString() } });
  } catch (err) {
    providerError(res, err);
  }
});

/** Effective (actually configured) resource limits. */
instancesRouter.get("/:id/config", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  try {
    const provider = getProviderForNode(row.node_id as string);
    const effective = await provider.readEffectiveConfig(row.node_id as string, row.container_id as string);
    const storage = await provider.getContainerStorage(row.node_id as string, row.container_id as string).catch(() => null);
    const lxcfsActive = effective.lxcfsActive ?? (row.node_id === "local" ? await isLxcfsActiveForContainer(row.container_id as string).catch(() => null) : null);
    res.json({
      data: {
        configured: { cpu: row.cpu, memory_mb: row.memory_mb, storage_gb: row.storage_gb },
        effective: { ...effective, cpuModel: effective.cpuModel ?? RESOURCE_MODEL },
        storage,
        lxcfs: lxcfsActive === null ? null : { active: lxcfsActive },
      },
    });
  } catch (err) {
    providerError(res, err);
  }
});

const resourcesSchema = z
  .object({
    cpu: z.number().int().min(1).max(32).optional(),
    memory_mb: z.number().int().min(128).max(131072).optional(),
    storage_gb: z.number().int().min(1).max(2000).optional(),
  })
  .refine((v) => v.cpu !== undefined || v.memory_mb !== undefined || v.storage_gb !== undefined, {
    message: "No resource changes provided.",
  });

/** Update enforced limits. CPU/memory via cgroups; storage only where quotas are enforceable. */
instancesRouter.patch("/:id/resources", validate(resourcesSchema), async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  // Changing allocations is admin-only; check before doing any host work.
  if (req.user!.role !== "admin") {
    forbidden(res);
    return;
  }
  const provider = getProviderForNode(row.node_id as string);
  const storageGb =
    (req.body.storage_gb as number | undefined) ?? (row.storage_gb as number);
  if (req.body.storage_gb !== undefined && req.body.storage_gb !== row.storage_gb) {
    if (row.node_id === "local") {
      try {
        const storage = await getContainerStorage(row.container_id as string);
        if (!storage.quotaSupported) {
          res.status(400).json({
            error: {
              code: "STORAGE_IMMUTABLE",
              message: `Disk quotas cannot be enforced on this backend (${storage.backend}): ${storage.note}`,
            },
          });
          return;
        }
        if (storage.backend === "btrfs") {
          const rootfs = containerRootfsPath(row.container_id as string);
          if (!(await isBtrfsSubvolume(rootfs))) {
            res.status(400).json({
              error: { code: "STORAGE_IMMUTABLE", message: "btrfs quota needs a subvolume layout; this rootfs is a plain directory." },
            });
            return;
          }
          await enforceBtrfsQuota(rootfs, storageGb);
        } else if (storage.backend === "ext4") {
          await enforceExt4Quota(
            containerRootfsPath(row.container_id as string),
            row.container_id as string,
            storageGb
          );
        } else {
          res.status(400).json({
            error: { code: "STORAGE_IMMUTABLE", message: `Disk quotas cannot be enforced on backend '${storage.backend}'.` },
          });
          return;
        }
      } catch (err) {
        providerError(res, err);
        return;
      }
    } else {
      try {
        const storage = await provider.getContainerStorage(row.node_id as string, row.container_id as string);
        if (!storage.quotaSupported) {
          res.status(400).json({
            error: {
              code: "STORAGE_IMMUTABLE",
              message: `Disk quotas cannot be enforced on this backend (${storage.backend}): ${storage.note ?? ""}`,
            },
          });
          return;
        }
      } catch (err) {
        providerError(res, err);
        return;
      }
    }
  }
  const cpu = (req.body.cpu as number | undefined) ?? (row.cpu as number);
  const memoryMb = (req.body.memory_mb as number | undefined) ?? (row.memory_mb as number);
  try {
    const result = await provider.applyResourceLimits(row.node_id as string, row.container_id as string, { cpu, memoryMb, storageGb });
    db.prepare("UPDATE instances SET cpu = ?, memory_mb = ?, storage_gb = ?, updated_at = ? WHERE id = ?").run(
      cpu,
      memoryMb,
      storageGb,
      nowIso(),
      row.id as string
    );
    const liveApplied = "liveApplied" in result ? result.liveApplied : true;
    const restartRequired = "restartRequired" in result ? result.restartRequired : false;
    const cgroupVersion = "cgroupVersion" in result ? result.cgroupVersion : "v2";
    recordAudit(db, {
      actorId: req.user!.id,
      action: "instance.resources_update",
      targetType: "instance",
      targetId: row.id as string,
      detail: { cpu, memory_mb: memoryMb, storage_gb: storageGb, liveApplied },
    });
    const effective = await provider.readEffectiveConfig(row.node_id as string, row.container_id as string).catch(() => null);
    res.json({
      data: {
        instance: toPublic({ ...row, cpu, memory_mb: memoryMb, storage_gb: storageGb }),
        liveApplied,
        restartRequired,
        cgroupVersion,
        effective,
      },
    });
  } catch (err) {
    providerError(res, err);
  }
});

const renameSchema = z.object({
  name: z.string().trim().min(2).max(63).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Invalid display name."),
});

/** Rename the display name. The container identifier is immutable. Admin-only. */
instancesRouter.patch("/:id", validate(renameSchema), (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (req.user!.role !== "admin") {
    forbidden(res);
    return;
  }
  db.prepare("UPDATE instances SET name = ?, updated_at = ? WHERE id = ?").run(
    (req.body.name as string).trim(),
    nowIso(),
    row.id as string
  );
  recordAudit(db, {
    actorId: req.user!.id,
    action: "instance.rename",
    targetType: "instance",
    targetId: row.id as string,
    detail: { name: (req.body.name as string).trim() },
  });
  const fresh = db.prepare("SELECT * FROM instances WHERE id = ?").get(row.id as string) as InstanceRow;
  res.json({ data: { instance: toPublic(fresh) } });
});

const notesSchema = z.object({
  notes: z.string().max(4000, "Notes must be 4000 characters or fewer."),
});

/**
 * Administrator note attached to a VPS (Proxmox-style single field). Everyone
 * who can see the instance can read it; only administrators may change it via
 * this endpoint. An empty (or whitespace-only) value clears the note. The note
 * is administrative metadata: it never touches the host container and is
 * allowed regardless of power or suspension state.
 */
instancesRouter.patch("/:id/notes", validate(notesSchema), (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (req.user!.role !== "admin") {
    forbidden(res);
    return;
  }
  const trimmed = (req.body.notes as string).trim();
  db.prepare("UPDATE instances SET notes = ?, updated_at = ? WHERE id = ?").run(
    trimmed.length > 0 ? trimmed : null,
    nowIso(),
    row.id as string
  );
  recordAudit(db, {
    actorId: req.user!.id,
    action: "instance.notes",
    targetType: "instance",
    targetId: row.id as string,
    detail: { length: trimmed.length, cleared: trimmed.length === 0 },
  });
  const fresh = db.prepare("SELECT * FROM instances WHERE id = ?").get(row.id as string) as InstanceRow;
  res.json({ data: { instance: toPublic(fresh) } });
});

async function destroyInstance(
  db: ReturnType<typeof getDb>,
  row: InstanceRow,
  actorId: string
): Promise<{ removedHostContainer: boolean }> {
  const nodeId = row.node_id as string | null;
  const containerId = row.container_id as string | null;
  let removedHostContainer = false;
  if (nodeId && containerId) {
    const provider = getProviderForNode(nodeId);
    if (!provider.capabilities.remove) {
      throw new ProviderError("UNSUPPORTED", "This operation is not supported by the current integration.", 409);
    }
    const existedBefore = await provider.containerExists(nodeId, containerId).catch(() => true);
    await provider.deleteContainer(nodeId, containerId);
    removedHostContainer = existedBefore;
    const stillThere = await provider.containerExists(nodeId, containerId).catch(() => false);
    if (stillThere) {
      throw new ProviderError("DESTROY_FAILED", "Container destroy ran but the container still exists.");
    }
  }
  db.prepare("DELETE FROM instances WHERE id = ?").run(row.id as string);
  recordAudit(db, {
    actorId,
    action: "instance.delete",
    targetType: "instance",
    targetId: row.id as string,
    detail: { container_id: containerId, removedHostContainer },
  });
  return { removedHostContainer };
}

/** Delete: admin-only. Destroys the exact host container, then drops the record. */
instancesRouter.delete("/:id", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (req.user!.role !== "admin") {
    forbidden(res);
    return;
  }
  try {
    const result = await destroyInstance(db, row, req.user!.id);
    res.json({ data: { removed: true, removedHostContainer: result.removedHostContainer } });
  } catch (err) {
    providerError(res, err);
  }
});

const actionSchema = z.object({ action: z.enum(["start", "stop", "restart", "remove"]) });

/**
 * Repair plan (read-only): compare DB allocation with effective host config.
 * Nothing is modified; use POST to apply the fixable items. Admin-only:
 * repairs change host configuration.
 */
instancesRouter.get("/:id/repair", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (req.user!.role !== "admin") {
    forbidden(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  try {
    const provider = getProviderForNode(row.node_id as string);
    const plan = await provider.planRepair(row.node_id as string, row.container_id as string, {
      cpu: Number(row.cpu),
      memoryMb: Number(row.memory_mb),
      storageGb: Number(row.storage_gb),
    });
    res.json({ data: { plan } });
  } catch (err) {
    providerError(res, err);
  }
});

/**
 * Apply a safe repair: re-apply drifted CPU/memory limits (config backed up
 * once, never overwritten), add the LXCFS include, enforce btrfs quotas.
 * Never destroys, recreates, migrates storage, or touches other containers.
 * Admin-only: repairs change host configuration.
 */
instancesRouter.post("/:id/repair", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (req.user!.role !== "admin") {
    forbidden(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  try {
    const provider = getProviderForNode(row.node_id as string);
    const report = await provider.applyRepair(row.node_id as string, row.container_id as string, {
      cpu: Number(row.cpu),
      memoryMb: Number(row.memory_mb),
      storageGb: Number(row.storage_gb),
    });
    recordAudit(db, {
      actorId: req.user!.id,
      action: "instance.repair",
      targetType: "instance",
      targetId: row.id as string,
      detail: { checks: report.checks.map((c) => `${c.check}:${c.status}`) },
    });
    res.json({ data: { report } });
  } catch (err) {
    providerError(res, err);
  }
});

/** Console preflight: is an interactive console actually available? No session is opened. */
instancesRouter.get("/:id/console", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  try {
    const provider = getProviderForNode(row.node_id as string);
    const preflight = await provider.checkConsole(row.node_id as string, row.container_id as string, row.template as string | undefined);
    res.json({ data: preflight });
  } catch (err) {
    providerError(res, err);
  }
});

/**
 * Instance power actions. Ownership is enforced server-side; every action is
 * confirmed against the real container state before the database is updated.
 */
instancesRouter.post("/:id/actions", async (req, res) => {
  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION", message: "Unsupported action." } });
    return;
  }
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  if (parsed.data.action === "remove") {
    // Destroying a VPS (host container + record) is an admin-only operation.
    if (req.user!.role !== "admin") {
      forbidden(res);
      return;
    }
    try {
      const result = await destroyInstance(db, row, req.user!.id);
      res.json({ data: { removed: true, removedHostContainer: result.removedHostContainer } });
      return;
    } catch (err) {
      providerError(res, err);
      return;
    }
  }
  if (row.status === "suspended") {
    // A suspended VPS stays put until an administrator lifts the hold.
    // ("remove" returns above; destruction is still allowed.)
    res.status(403).json({
      error: { code: "INSTANCE_SUSPENDED", message: "This VPS is suspended. Unsuspend it before start, stop, or restart." },
    });
    return;
  }
  const provider = getProviderForNode(String(row.node_id));
  const action = parsed.data.action;
  const previousStatus = String(row.status);
  try {
    if (action === "start" && provider.capabilities.start) {
      await provider.startContainer(String(row.node_id), String(row.container_id));
    } else if (action === "stop" && provider.capabilities.stop) {
      await provider.stopContainer(String(row.node_id), String(row.container_id));
    } else if (action === "restart" && provider.capabilities.start && provider.capabilities.stop) {
      await provider.stopContainer(String(row.node_id), String(row.container_id));
      await provider.startContainer(String(row.node_id), String(row.container_id));
    } else {
      res.status(409).json({
        error: { code: "UNSUPPORTED", message: "This operation is not supported by the current integration." },
      });
      return;
    }
    // Confirm against the host; only then persist. Never fake success.
    const live = await readLiveState(row);
    if (row.status !== "suspended" && live.exists && live.status) {
      db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run(
        live.status,
        nowIso(),
        row.id as string
      );
      row.status = live.status;
    }
    recordAudit(db, {
      actorId: req.user!.id,
      action: "instance.power",
      targetType: "instance",
      targetId: row.id as string,
      detail: { action, container_id: row.container_id, previous_status: previousStatus, status: row.status },
    });
    res.json({ data: { instance: toPublic(row), live } });
  } catch (err) {
    recordAudit(db, {
      actorId: req.user?.id,
      action: "instance.power",
      targetType: "instance",
      targetId: row.id as string,
      detail: {
        action,
        container_id: row.container_id,
        outcome: "failed",
        error: err instanceof ProviderError ? `${err.code}: ${err.message}` : "Infrastructure operation failed.",
      },
    });
    providerError(res, err);
  }
});

/**
 * Suspend: admin-only hold that stops a running container (when the host can
 * be verified) and blocks start/stop/restart until lifted. When the host
 * cannot be checked, the hold is still recorded — the response reports the
 * unverified live state honestly instead of claiming the container stopped.
 */
instancesRouter.post("/:id/suspend", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (req.user!.role !== "admin") {
    forbidden(res);
    return;
  }
  if (row.status === "suspended") {
    res.status(409).json({ error: { code: "ALREADY_SUSPENDED", message: "Instance is already suspended." } });
    return;
  }
  const previousStatus = String(row.status);
  try {
    const live = await readLiveState(row);
    if (live.exists && live.status === "running") {
      const provider = getProviderForNode(String(row.node_id));
      if (!provider.capabilities.stop) {
        res.status(409).json({
          error: { code: "UNSUPPORTED", message: "This operation is not supported by the current integration." },
        });
        return;
      }
      await provider.stopContainer(String(row.node_id), String(row.container_id));
      const confirm = await readLiveState(row);
      if (!(confirm.exists && confirm.status === "stopped")) {
        res.status(502).json({
          error: { code: "SUSPEND_FAILED", message: "Container could not be stopped; suspend aborted with nothing changed." },
        });
        return;
      }
    }
    db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run(
      "suspended",
      nowIso(),
      row.id as string
    );
    row.status = "suspended";
    row.updated_at = nowIso();
    recordAudit(db, {
      actorId: req.user!.id,
      action: "instance.suspend",
      targetType: "instance",
      targetId: row.id as string,
      detail: { previous_status: previousStatus, container_id: row.container_id, host_verified: live.exists === true },
    });
    res.json({ data: { instance: toPublic(row), live } });
  } catch (err) {
    providerError(res, err);
  }
});

/**
 * Unsuspend: lift the administrative hold. The container is not started —
 * that remains an explicit power action. The stored status follows verified
 * host truth, falling back to `unknown` when the host cannot be checked.
 */
instancesRouter.post("/:id/unsuspend", async (req, res) => {
  const db = getDb();
  const row = getManagedInstance(db, req.params.id, req.user!);
  if (!row) {
    notFound(res);
    return;
  }
  if (req.user!.role !== "admin") {
    forbidden(res);
    return;
  }
  if (row.status !== "suspended") {
    res.status(409).json({ error: { code: "NOT_SUSPENDED", message: "Instance is not suspended." } });
    return;
  }
  const live = await readLiveState(row);
  const next = live.exists && live.status === "running" ? "running" : live.exists && live.status === "stopped" ? "stopped" : "unknown";
  db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run(next, nowIso(), row.id as string);
  row.status = next;
  row.updated_at = nowIso();
  recordAudit(db, {
    actorId: req.user!.id,
    action: "instance.unsuspend",
    targetType: "instance",
    targetId: row.id as string,
    detail: { previous_status: "suspended", status: next, container_id: row.container_id },
  });
  res.json({ data: { instance: toPublic(row), live } });
});

export const templatesRouter = Router();
templatesRouter.use(requireAuth);
templatesRouter.get("/", (_req, res) => {
  res.json({ data: { templates: LocalLxcProvider.supportedTemplates() } });
});
