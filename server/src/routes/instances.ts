import { Router, type Response } from "express";
import { z } from "zod";
import { getDb, nowIso } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  getProvider,
  LocalLxcProvider,
  applyResourceLimits,
  containerExistsOnHost,
  getContainerMetrics,
  getContainerNetwork,
  readContainerState,
  readEffectiveConfig,
} from "../services/virtualization/localAgent.js";
import { checkConsoleRunnable } from "../services/virtualization/console.js";
import { ProviderError } from "../services/virtualization/provider.js";

export const instancesRouter = Router();
instancesRouter.use(requireAuth);

type InstanceRow = Record<string, unknown>;

function toPublic(row: Record<string, unknown>): Record<string, unknown> {
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
  const row = getOwnedInstance(db, req.params.id, req.user!.id);
  if (!row) {
    notFound(res);
    return;
  }
  // Reconcile with the real host: never present stale DB status as truth.
  const live = await readLiveState(row);
  if (live.exists && (live.status === "running" || live.status === "stopped") && live.status !== row.status) {
    db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run(
      live.status,
      nowIso(),
      row.id as string
    );
    row.status = live.status;
    row.updated_at = nowIso();
  }
  res.json({ data: { instance: toPublic(row), live } });
});

interface LiveState {
  /** true = on host, false = checked and absent, null = could not check. */
  exists: boolean | null;
  status: string | null;
  checkedAt: string;
  error: string | null;
}

async function readLiveState(row: InstanceRow): Promise<LiveState> {
  const checkedAt = new Date().toISOString();
  const nodeId = row.node_id as string | null;
  const containerId = row.container_id as string | null;
  if (!nodeId || !containerId) {
    return { exists: false, status: null, checkedAt, error: "Instance is not attached to a configured node." };
  }
  let exists: boolean;
  try {
    exists = await containerExistsOnHost(containerId);
  } catch (err) {
    // The inventory itself is unreadable (e.g. no LXC tooling): unknown, not absent.
    const message = err instanceof ProviderError ? err.message : "Live state could not be read.";
    return { exists: null, status: null, checkedAt, error: message };
  }
  if (!exists) {
    return { exists: false, status: null, checkedAt, error: "No matching container exists on the host." };
  }
  try {
    const state = await readContainerState(containerId);
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
  const row = getOwnedInstance(db, req.params.id, req.user!.id);
  if (!row) {
    notFound(res);
    return;
  }
  const live = await readLiveState(row);
  let metrics: { cpuSeconds: number | null; memoryMb: number | null } | null = null;
  if (live.exists && live.status === "running") {
    try {
      metrics = await getContainerMetrics(row.container_id as string);
    } catch {
      metrics = null;
    }
  }
  res.json({ data: { live, metrics } });
});

/** Live network facts from the host. */
instancesRouter.get("/:id/network", async (req, res) => {
  const db = getDb();
  const row = getOwnedInstance(db, req.params.id, req.user!.id);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  try {
    const network = await getContainerNetwork(row.container_id as string);
    res.json({ data: { network, checkedAt: new Date().toISOString() } });
  } catch (err) {
    providerError(res, err);
  }
});

/** Effective (actually configured) resource limits. */
instancesRouter.get("/:id/config", async (req, res) => {
  const db = getDb();
  const row = getOwnedInstance(db, req.params.id, req.user!.id);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  try {
    const effective = await readEffectiveConfig(row.container_id as string);
    res.json({
      data: {
        configured: { cpu: row.cpu, memory_mb: row.memory_mb, storage_gb: row.storage_gb },
        effective,
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

/** Update enforced CPU/memory limits. Storage quotas are honestly unsupported. */
instancesRouter.patch("/:id/resources", validate(resourcesSchema), async (req, res) => {
  const db = getDb();
  const row = getOwnedInstance(db, req.params.id, req.user!.id);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  if (req.body.storage_gb !== undefined && req.body.storage_gb !== row.storage_gb) {
    res.status(400).json({
      error: {
        code: "STORAGE_IMMUTABLE",
        message: "Disk quotas are not enforced by the directory storage backend and cannot be changed.",
      },
    });
    return;
  }
  const cpu = (req.body.cpu as number | undefined) ?? (row.cpu as number);
  const memoryMb = (req.body.memory_mb as number | undefined) ?? (row.memory_mb as number);
  try {
    const result = await applyResourceLimits(row.container_id as string, { cpu, memoryMb });
    db.prepare("UPDATE instances SET cpu = ?, memory_mb = ?, updated_at = ? WHERE id = ?").run(
      cpu,
      memoryMb,
      nowIso(),
      row.id as string
    );
    recordAudit(db, {
      actorId: req.user!.id,
      action: "instance.resources_update",
      targetType: "instance",
      targetId: row.id as string,
      detail: { cpu, memory_mb: memoryMb, liveApplied: result.liveApplied },
    });
    const effective = await readEffectiveConfig(row.container_id as string).catch(() => null);
    res.json({
      data: {
        instance: toPublic({ ...row, cpu, memory_mb: memoryMb }),
        liveApplied: result.liveApplied,
        restartRequired: result.restartRequired,
        cgroupVersion: result.cgroupVersion,
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

/** Rename the display name. The container identifier is immutable. */
instancesRouter.patch("/:id", validate(renameSchema), (req, res) => {
  const db = getDb();
  const row = getOwnedInstance(db, req.params.id, req.user!.id);
  if (!row) {
    notFound(res);
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

async function destroyInstance(
  db: ReturnType<typeof getDb>,
  row: InstanceRow,
  actorId: string
): Promise<{ removedHostContainer: boolean }> {
  const nodeId = row.node_id as string | null;
  const containerId = row.container_id as string | null;
  let removedHostContainer = false;
  if (nodeId && containerId) {
    const provider = getProvider();
    if (!provider.capabilities.remove) {
      throw new ProviderError("UNSUPPORTED", "This operation is not supported by the current integration.", 409);
    }
    const existedBefore = await containerExistsOnHost(containerId).catch(() => true);
    await provider.deleteContainer(nodeId, containerId);
    removedHostContainer = existedBefore;
    const stillThere = await containerExistsOnHost(containerId).catch(() => false);
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

/** Delete: verify ownership, destroy the exact host container, then drop the record. */
instancesRouter.delete("/:id", async (req, res) => {
  const db = getDb();
  const row = getOwnedInstance(db, req.params.id, req.user!.id);
  if (!row) {
    notFound(res);
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

/** Console preflight: is an interactive console actually available? No session is opened. */
instancesRouter.get("/:id/console", async (req, res) => {
  const db = getDb();
  const row = getOwnedInstance(db, req.params.id, req.user!.id);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  try {
    const preflight = await checkConsoleRunnable(row);
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
  const row = getOwnedInstance(db, req.params.id, req.user!.id);
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  if (parsed.data.action === "remove") {
    try {
      const result = await destroyInstance(db, row, req.user!.id);
      res.json({ data: { removed: true, removedHostContainer: result.removedHostContainer } });
      return;
    } catch (err) {
      providerError(res, err);
      return;
    }
  }
  const provider = getProvider();
  const action = parsed.data.action;
  const want = action === "stop" ? "stopped" : "running";
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
    if (live.exists && live.status) {
      db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run(
        live.status,
        nowIso(),
        row.id as string
      );
      row.status = live.status;
    }
    res.json({ data: { instance: toPublic(row), live } });
  } catch (err) {
    providerError(res, err);
  }
});

export const templatesRouter = Router();
templatesRouter.use(requireAuth);
templatesRouter.get("/", (_req, res) => {
  res.json({ data: { templates: LocalLxcProvider.supportedTemplates() } });
});
