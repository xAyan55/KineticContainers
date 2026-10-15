import { Router } from "express";
import { z } from "zod";
import { getDb, nowIso } from "../../db.js";
import { requireAdmin, requireAuth } from "../../middleware/auth.js";
import { validate, validateQuery } from "../../middleware/validate.js";
import { recordAudit } from "../../services/audit.js";
import { getProvider } from "../../services/virtualization/localAgent.js";
import { ProviderError } from "../../services/virtualization/provider.js";
import { reconcileStoredStatus, toPublic } from "../instances.js";

/**
 * Administrator instance management (`/api/admin/instances`).
 *
 * Unlike `GET /api/instances` — which is strictly owner-scoped — every route
 * here returns all panel-managed instances with their real owner and node
 * relationships. All routes require an administrator session.
 *
 * Live host state is read from the real provider per request (batched per
 * node, never persisted by the list endpoint) so the UI can distinguish a
 * container that is genuinely missing from a host that cannot be reached.
 * An unreadable provider is reported as `exists: null`, never as absent.
 */

export const adminInstancesRouter = Router();
adminInstancesRouter.use(requireAuth, requireAdmin);

type JoinedRow = Record<string, unknown>;

interface LiveState {
  /** true = on host, false = checked and absent, null = could not check. */
  exists: boolean | null;
  status: string | null;
  checkedAt: string;
  error: string | null;
}

const SELECT = `SELECT i.*,
  n.name AS node_name,
  u.id AS o_id, u.name AS o_name, u.email AS o_email, u.role AS o_role,
  u.status AS o_status, u.avatar_seed AS o_avatar, u.created_at AS o_created,
  n.id AS n_id, n.name AS n_name, n.endpoint AS n_endpoint, n.status AS n_status
  FROM instances i
  LEFT JOIN users u ON u.id = i.owner_id
  LEFT JOIN nodes n ON n.id = i.node_id`;

function toPublicOwner(row: JoinedRow): Record<string, unknown> | null {
  if (!row.o_id) return null;
  return {
    id: row.o_id,
    name: row.o_name,
    email: row.o_email,
    role: row.o_role,
    status: row.o_status,
    avatar_seed: row.o_avatar,
    created_at: row.o_created,
  };
}

function toPublicNode(row: JoinedRow): Record<string, unknown> | null {
  if (!row.n_id) return null;
  return { id: row.n_id, name: row.n_name, endpoint: row.n_endpoint, status: row.n_status };
}

function toAdminInstance(row: JoinedRow, live: LiveState): Record<string, unknown> {
  return {
    ...toPublic(row),
    owner_id: row.owner_id,
    owner: toPublicOwner(row),
    node: toPublicNode(row),
    live,
  };
}

/**
 * Read live state for a batch of rows with one inventory listing per node.
 * Never throws: per-node failures mark that node's rows as unavailable.
 */
async function readLiveForRows(rows: JoinedRow[]): Promise<Map<string, LiveState>> {
  const checkedAt = new Date().toISOString();
  const out = new Map<string, LiveState>();
  const byNode = new Map<string, JoinedRow[]>();
  for (const row of rows) {
    const id = String(row.id);
    const nodeId = row.node_id as string | null;
    const containerId = row.container_id as string | null;
    if (!nodeId || !containerId) {
      out.set(id, { exists: false, status: null, checkedAt, error: "Instance is not attached to a configured node." });
      continue;
    }
    if (!row.n_id) {
      out.set(id, {
        exists: null,
        status: null,
        checkedAt,
        error: `Virtualization node "${nodeId}" is not registered; host state cannot be checked.`,
      });
      continue;
    }
    const group = byNode.get(nodeId);
    if (group) group.push(row);
    else byNode.set(nodeId, [row]);
  }
  for (const [nodeId, group] of byNode) {
    let inventory: Map<string, string> | null = null;
    let failure: string | null = null;
    try {
      const containers = await getProvider().listContainers(nodeId);
      inventory = new Map(containers.map((c) => [c.containerId, c.status]));
    } catch (err) {
      failure = err instanceof ProviderError ? err.message : "Host inventory could not be read.";
    }
    for (const row of group) {
      const id = String(row.id);
      if (failure !== null || inventory === null) {
        out.set(id, { exists: null, status: null, checkedAt, error: failure ?? "Host inventory could not be read." });
        continue;
      }
      const status = inventory.get(String(row.container_id));
      out.set(
        id,
        status === undefined
          ? { exists: false, status: null, checkedAt, error: "No matching container exists on the host." }
          : { exists: true, status, checkedAt, error: null }
      );
    }
  }
  return out;
}

const DB_STATUSES = ["running", "stopped", "starting", "stopping", "failed", "unknown", "suspended"] as const;

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().trim().max(200).optional(),
  status: z
    .enum(["running", "stopped", "starting", "stopping", "transitional", "failed", "unknown", "suspended", "missing", "unavailable"])
    .optional(),
  node_id: z.string().trim().max(128).optional(),
  owner_id: z.string().trim().max(128).optional(),
  template: z.string().trim().max(64).optional(),
  sort: z.enum(["created_at", "name", "status", "cpu", "memory_mb", "storage_gb"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

const SORT_COLUMNS: Record<string, string> = {
  created_at: "i.created_at",
  name: "i.name",
  status: "i.status",
  cpu: "i.cpu",
  memory_mb: "i.memory_mb",
  storage_gb: "i.storage_gb",
};

/** Upper bound for the in-memory scan backing the live-state filters. */
const LIVE_SCAN_CAP = 1000;

interface ListFilters {
  q?: string;
  node_id?: string;
  owner_id?: string;
  template?: string;
}

function buildWhere(f: ListFilters, statusValues?: readonly string[]): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.q) {
    const like = `%${f.q.toLowerCase()}%`;
    where.push(
      "(lower(i.name) LIKE ? OR lower(i.container_id) LIKE ? OR lower(i.id) LIKE ? OR lower(u.name) LIKE ? OR lower(u.email) LIKE ?)"
    );
    params.push(like, like, like, like, like);
  }
  if (f.node_id) {
    where.push("i.node_id = ?");
    params.push(f.node_id);
  }
  if (f.owner_id) {
    where.push("i.owner_id = ?");
    params.push(f.owner_id);
  }
  if (f.template) {
    where.push("i.template = ?");
    params.push(f.template);
  }
  if (statusValues && statusValues.length > 0) {
    where.push(`i.status IN (${statusValues.map(() => "?").join(",")})`);
    params.push(...statusValues);
  }
  return { clause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", params };
}

adminInstancesRouter.get("/", validateQuery(listQuery), async (req, res) => {
  const db = getDb();
  const q = (req.validatedQuery ?? {}) as {
    page?: number;
    page_size?: number;
    q?: string;
    status?: string;
    node_id?: string;
    owner_id?: string;
    template?: string;
    sort?: keyof typeof SORT_COLUMNS;
    order?: "asc" | "desc";
  };
  const page = q.page ?? 1;
  const pageSize = q.page_size ?? 25;
  const sortCol = SORT_COLUMNS[q.sort ?? "created_at"];
  const order = (q.order ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const filters: ListFilters = { q: q.q, node_id: q.node_id, owner_id: q.owner_id, template: q.template };

  // Live-state filters need host data, so scan a bounded candidate set and
  // paginate in memory. Plain status filters stay in SQL.
  const liveFilter = q.status === "missing" || q.status === "unavailable";
  const dbStatuses =
    q.status === "transitional"
      ? (["starting", "stopping"] as const)
      : q.status && (DB_STATUSES as readonly string[]).includes(q.status)
        ? [q.status]
        : undefined;

  if (liveFilter) {
    const { clause, params } = buildWhere(filters);
    const candidates = db
      .prepare(`${SELECT} ${clause} ORDER BY ${sortCol} ${order} LIMIT ?`)
      .all(...(params as never[]), LIVE_SCAN_CAP) as JoinedRow[];
    const liveById = await readLiveForRows(candidates);
    const wantMissing = q.status === "missing";
    const matched = candidates.filter((row) => {
      const live = liveById.get(String(row.id));
      return wantMissing ? live?.exists === false : live?.exists === null;
    });
    const total = matched.length;
    const slice = matched.slice((page - 1) * pageSize, page * pageSize);
    res.json({
      data: {
        instances: slice.map((row) => toAdminInstance(row, liveById.get(String(row.id))!)),
        pagination: { page, page_size: pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
      },
    });
    return;
  }

  const { clause, params } = buildWhere(filters, dbStatuses);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM instances i LEFT JOIN users u ON u.id = i.owner_id ${clause}`).get(...(params as never[])) as { n: number }).n;
  const rows = db
    .prepare(`${SELECT} ${clause} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`)
    .all(...(params as never[]), pageSize, (page - 1) * pageSize) as JoinedRow[];
  const liveById = await readLiveForRows(rows);
  res.json({
    data: {
      instances: rows.map((row) => toAdminInstance(row, liveById.get(String(row.id))!)),
      pagination: { page, page_size: pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
    },
  });
});

/** Recorded-status counts plus integrity markers. DB-based; live state is per-instance. */
adminInstancesRouter.get("/stats", (_req, res) => {
  const db = getDb();
  const byStatus = db.prepare("SELECT status, COUNT(*) AS n FROM instances GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  const counts: Record<string, number> = { running: 0, stopped: 0, transitional: 0, failed: 0, unknown: 0, suspended: 0, other: 0 };
  let total = 0;
  for (const row of byStatus) {
    total += row.n;
    if (row.status === "running" || row.status === "stopped" || row.status === "failed" || row.status === "unknown" || row.status === "suspended") {
      counts[row.status] += row.n;
    } else if (row.status === "starting" || row.status === "stopping") {
      counts.transitional += row.n;
    } else {
      counts.other += row.n;
    }
  }
  const missingOwner = (
    db
      .prepare("SELECT COUNT(*) AS n FROM instances i LEFT JOIN users u ON u.id = i.owner_id WHERE u.id IS NULL")
      .get() as { n: number }
  ).n;
  const missingNode = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM instances i LEFT JOIN nodes n ON n.id = i.node_id WHERE i.node_id IS NOT NULL AND n.id IS NULL"
      )
      .get() as { n: number }
  ).n;
  const unattachedNode = (db.prepare("SELECT COUNT(*) AS n FROM instances WHERE node_id IS NULL").get() as { n: number }).n;
  const nodeDegraded = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM instances i JOIN nodes n ON n.id = i.node_id WHERE n.last_check_ok = 0"
      )
      .get() as { n: number }
  ).n;
  res.json({
    data: {
      stats: { total, ...counts, missing_owner: missingOwner, missing_node: missingNode, unattached_node: unattachedNode, node_degraded: nodeDegraded },
    },
  });
});

function adminDetail(row: JoinedRow, live: LiveState): Record<string, unknown> {
  return { instance: toAdminInstance(row, live), owner: toPublicOwner(row), node: toPublicNode(row), live };
}

adminInstancesRouter.get("/:id", async (req, res) => {
  const db = getDb();
  const row = db.prepare(`${SELECT} WHERE i.id = ?`).get(req.params.id) as JoinedRow | undefined;
  if (!row) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Instance not found." } });
    return;
  }
  const live = (await readLiveForRows([row])).get(String(row.id))!;
  // Reconcile the stored status with verified host truth, like the panel
  // detail view. Suspension is an administrative hold and is never overwritten.
  reconcileStoredStatus(db, row, live);
  res.json({ data: adminDetail(row, live) });
});

const transferSchema = z.object({ target_user_id: z.string().trim().min(1).max(128) });

/**
 * Move a single instance to another existing, active user. The host
 * container is untouched; only the ownership relationship changes.
 */
adminInstancesRouter.post("/:id/transfer", validate(transferSchema), (req, res) => {
  const db = getDb();
  const row = db.prepare(`${SELECT} WHERE i.id = ?`).get(req.params.id) as JoinedRow | undefined;
  if (!row) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Instance not found." } });
    return;
  }
  const targetId = (req.body.target_user_id as string).trim();
  const target = db.prepare("SELECT id, name, email, status FROM users WHERE id = ?").get(targetId) as
    | { id: string; name: string; email: string; status: string }
    | undefined;
  if (!target) {
    res.status(404).json({ error: { code: "TARGET_NOT_FOUND", message: "Target user not found." } });
    return;
  }
  if (target.status !== "active") {
    res.status(409).json({ error: { code: "TARGET_DISABLED", message: "Instances can only be transferred to active users." } });
    return;
  }
  if (row.owner_id === target.id) {
    res.status(400).json({ error: { code: "VALIDATION", message: "Instance is already owned by this user." } });
    return;
  }
  const previousOwner = String(row.owner_id);
  db.prepare("UPDATE instances SET owner_id = ?, updated_at = ? WHERE id = ?").run(target.id, nowIso(), row.id as string);
  recordAudit(db, {
    actorId: req.user!.id,
    action: "admin.instance_transfer",
    targetType: "instance",
    targetId: String(row.id),
    detail: { from: previousOwner, to: target.id },
  });
  const fresh = db.prepare(`${SELECT} WHERE i.id = ?`).get(req.params.id) as JoinedRow;
  const live = { exists: null, status: null, checkedAt: new Date().toISOString(), error: "Live state not re-checked by this operation." } as LiveState;
  res.json({ data: adminDetail(fresh, live) });
});
