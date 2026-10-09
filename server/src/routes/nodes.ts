import { Router } from "express";
import { z } from "zod";
import { getDb, newId, nowIso } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { getProvider } from "../services/virtualization/localAgent.js";
import { checkNodeHealth, getNodeContainers } from "../services/virtualization/host.js";
import { ProviderError } from "../services/virtualization/provider.js";

export const nodesRouter = Router();
nodesRouter.use(requireAuth, requireAdmin);

type NodeRow = Record<string, unknown>;

/** Strip secrets and normalize flags. api_token is never exposed. */
function publicNode(row: NodeRow): Record<string, unknown> {
  const { api_token: _token, ...rest } = row;
  return {
    ...rest,
    is_protected: Number(row.is_protected ?? 0) === 1,
    last_check_ok:
      row.last_check_ok === null || row.last_check_ok === undefined
        ? null
        : Number(row.last_check_ok) === 1,
  };
}

function withManagedCount(row: NodeRow, db: ReturnType<typeof getDb>): Record<string, unknown> {
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM instances WHERE node_id = ?").get(row.id as string) as {
      n: number;
    }
  ).n;
  return { ...publicNode(row), managed_containers: n };
}

function findNode(db: ReturnType<typeof getDb>, id: string): NodeRow | undefined {
  return db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
}

nodesRouter.get("/", (_req, res) => {
  const db = getDb();
  const nodes = db
    .prepare(
      `SELECT *, (SELECT COUNT(*) FROM instances i WHERE i.node_id = nodes.id) AS managed_containers
       FROM nodes ORDER BY CASE WHEN id = 'local' THEN 0 ELSE 1 END, created_at ASC`
    )
    .all() as (NodeRow & { managed_containers: number })[];
  res.json({
    data: {
      nodes: nodes.map((n) => {
        const { managed_containers, ...rest } = n;
        return { ...publicNode(rest), managed_containers };
      }),
      provider: getProvider().kind,
    },
  });
});

nodesRouter.get("/:id", (req, res) => {
  const db = getDb();
  const node = findNode(db, req.params.id);
  if (!node) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  res.json({ data: { node: withManagedCount(node, db) } });
});

/** Run a fresh health check and persist the outcome. */
nodesRouter.post("/:id/check", async (req, res) => {
  const db = getDb();
  if (!findNode(db, req.params.id)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  try {
    const check = await checkNodeHealth(db, req.params.id);
    recordAudit(db, {
      actorId: req.user!.id,
      action: "node.check",
      targetType: "node",
      targetId: req.params.id,
      detail: { status: check.status },
    });
    if (!check.ok && check.status === "unavailable") {
      res.status(409).json({
        error: { code: "REMOTE_NODE_UNSUPPORTED", message: check.detail },
        data: { check },
      });
      return;
    }
    // A completed check is a 200 even when it reports problems: the payload
    // (ok/status/detail) is the result. Only un-runnable checks use errors.
    res.status(200).json({ data: { check } });
  } catch (err) {
    if (err instanceof ProviderError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ error: { code: "INTERNAL", message: "Health check failed." } });
  }
});

/** Live container inventory with KineticCT ownership resolved. */
nodesRouter.get("/:id/containers", async (req, res) => {
  const db = getDb();
  try {
    const inventory = await getNodeContainers(db, req.params.id);
    res.json({ data: inventory });
  } catch (err) {
    if (err instanceof ProviderError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ error: { code: "INTERNAL", message: "Could not read container inventory." } });
  }
});

const patchSchema = z.object({
  // Only the display name is editable. Identity fields (id, endpoint,
  // node_type, provider) are immutable so a local node can never be
  // converted into a remote one through ordinary editing.
  name: z.string().trim().min(1).max(120),
});

nodesRouter.patch("/:id", validate(patchSchema), (req, res) => {
  const db = getDb();
  const node = findNode(db, req.params.id);
  if (!node) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  db.prepare("UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?").run(
    req.body.name.trim(),
    nowIso(),
    node.id as string
  );
  recordAudit(db, {
    actorId: req.user!.id,
    action: "node.rename",
    targetType: "node",
    targetId: node.id as string,
    detail: { name: req.body.name.trim() },
  });
  res.json({ data: { node: withManagedCount(findNode(db, node.id as string)!, db) } });
});

const hostAddressSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[a-zA-Z0-9]([a-zA-Z0-9.:_-]{0,253}[a-zA-Z0-9])?$/,
    "Host address must be a hostname or IP address."
  );

const nodeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  connection: z.enum(["local", "remote"]).optional().default("remote"),
  // Optional with no default: absent stays undefined (a "" default would be
  // re-validated against min(1)/regex by this zod version and wrongly fail).
  host_address: hostAddressSchema.optional(),
  api_token: z.string().max(1024).optional().default(""),
});

nodesRouter.post("/", validate(nodeSchema), (req, res) => {
  const db = getDb();
  const now = nowIso();
  const connection = req.body.connection as "local" | "remote";

  if (connection === "local") {
    const existing = db
      .prepare("SELECT id FROM nodes WHERE id = 'local' OR endpoint = 'local'")
      .get() as { id: string } | undefined;
    if (existing) {
      res.status(409).json({
        error: {
          code: "LOCAL_NODE_EXISTS",
          message: "The Local Node is already registered automatically. No manual setup is needed.",
        },
      });
      return;
    }
    const id = newId("node");
    db.prepare(
      "INSERT INTO nodes (id, name, endpoint, api_token, status, node_type, provider, is_protected, created_at, updated_at) VALUES (?, ?, 'local', ?, 'unknown', 'local', 'local-lxc', 0, ?, ?)"
    ).run(id, req.body.name.trim(), String(req.body.api_token ?? ""), now, now);
    recordAudit(db, { actorId: req.user!.id, action: "node.register", targetType: "node", targetId: id });
    res.status(201).json({ data: { node: withManagedCount(findNode(db, id)!, db) } });
    return;
  }

  // Remote records are configuration only: no secure remote agent exists yet.
  const host = String(req.body.host_address ?? "").trim();
  if (!host) {
    res.status(400).json({ error: { code: "VALIDATION", message: "A host address is required for remote nodes." } });
    return;
  }
  const clash = db.prepare("SELECT id FROM nodes WHERE endpoint = ?").get(host) as { id: string } | undefined;
  if (clash) {
    res.status(409).json({ error: { code: "NODE_EXISTS", message: "A node with this host address is already registered." } });
    return;
  }
  const id = newId("node");
  const detail = "Saved but not verified: remote node agents are not implemented yet.";
  db.prepare(
    "INSERT INTO nodes (id, name, endpoint, api_token, status, node_type, provider, host_address, last_error, is_protected, created_at, updated_at) VALUES (?, ?, ?, ?, 'unconfigured', 'remote', 'remote-agent', ?, ?, 0, ?, ?)"
  ).run(id, req.body.name.trim(), host, String(req.body.api_token ?? ""), host, detail, now, now);
  recordAudit(db, {
    actorId: req.user!.id,
    action: "node.register",
    targetType: "node",
    targetId: id,
    detail: { connection: "remote", host },
  });
  res.status(201).json({ data: { node: withManagedCount(findNode(db, id)!, db) } });
});

nodesRouter.post("/:id/test", async (req, res) => {
  const db = getDb();
  const node = db.prepare("SELECT id FROM nodes WHERE id = ?").get(req.params.id) as { id: string } | undefined;
  if (!node) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  try {
    const provider = getProvider();
    const status = await provider.getNodeStatus(node.id);
    db.prepare("UPDATE nodes SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?").run(
      "online",
      nowIso(),
      nowIso(),
      node.id
    );
    res.json({ data: { status } });
  } catch (err) {
    db.prepare("UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?").run("offline", nowIso(), node.id);
    res.status(502).json({
      error: { code: "NODE_UNREACHABLE", message: err instanceof Error ? err.message : "Node unreachable." },
    });
  }
});

nodesRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const node = findNode(db, req.params.id);
  if (!node) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Node not found." } });
    return;
  }
  // The Local Node is the panel's own host: never removable via the API.
  if (node.id === "local" || Number(node.is_protected ?? 0) === 1) {
    res.status(403).json({
      error: { code: "NODE_PROTECTED", message: "The Local Node cannot be removed. It represents this panel's own host." },
    });
    return;
  }
  const attached = (db.prepare("SELECT COUNT(*) AS n FROM instances WHERE node_id = ?").get(req.params.id) as { n: number }).n;
  if (attached > 0) {
    res.status(409).json({
      error: { code: "NODE_IN_USE", message: `Node still hosts ${attached} instance record(s). Reassign or remove them first.` },
    });
    return;
  }
  db.prepare("DELETE FROM nodes WHERE id = ?").run(req.params.id);
  recordAudit(db, { actorId: req.user!.id, action: "node.remove", targetType: "node", targetId: req.params.id });
  res.json({ data: { ok: true } });
});
