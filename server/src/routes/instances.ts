import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getProvider, LocalLxcProvider } from "../services/virtualization/localAgent.js";
import { ProviderError } from "../services/virtualization/provider.js";

export const instancesRouter = Router();
instancesRouter.use(requireAuth);

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

instancesRouter.get("/", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT i.*, n.name AS node_name FROM instances i LEFT JOIN nodes n ON n.id = i.node_id WHERE i.owner_id = ? ORDER BY i.created_at DESC`
    )
    .all(req.user!.id) as Record<string, unknown>[];
  res.json({ data: { instances: rows.map(toPublic) } });
});

instancesRouter.get("/:id", (req, res) => {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT i.*, n.name AS node_name FROM instances i LEFT JOIN nodes n ON n.id = i.node_id WHERE i.id = ? AND i.owner_id = ?`
    )
    .get(req.params.id, req.user!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Instance not found." } });
    return;
  }
  res.json({ data: { instance: toPublic(row) } });
});

const actionSchema = z.object({ action: z.enum(["start", "stop", "restart", "remove"]) });

/**
 * Instance power actions. Ownership is enforced server-side; the host
 * operation only runs when the integration reports the capability.
 */
instancesRouter.post("/:id/actions", async (req, res) => {
  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION", message: "Unsupported action." } });
    return;
  }
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM instances WHERE id = ? AND owner_id = ?")
    .get(req.params.id, req.user!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Instance not found." } });
    return;
  }
  if (!row.node_id || !row.container_id) {
    res.status(409).json({ error: { code: "NO_NODE", message: "Instance is not attached to a configured node." } });
    return;
  }
  const provider = getProvider();
  const action = parsed.data.action;
  try {
    if (action === "start" && provider.capabilities.start) {
      await provider.startContainer(String(row.node_id), String(row.container_id));
      db.prepare("UPDATE instances SET status = 'running' WHERE id = ?").run(row.id as string);
    } else if (action === "stop" && provider.capabilities.stop) {
      await provider.stopContainer(String(row.node_id), String(row.container_id));
      db.prepare("UPDATE instances SET status = 'stopped' WHERE id = ?").run(row.id as string);
    } else if (action === "restart" && provider.capabilities.start && provider.capabilities.stop) {
      await provider.stopContainer(String(row.node_id), String(row.container_id));
      await provider.startContainer(String(row.node_id), String(row.container_id));
      db.prepare("UPDATE instances SET status = 'running' WHERE id = ?").run(row.id as string);
    } else if (action === "remove" && provider.capabilities.remove) {
      await provider.deleteContainer(String(row.node_id), String(row.container_id));
      db.prepare("DELETE FROM instances WHERE id = ?").run(row.id as string);
      res.json({ data: { removed: true } });
      return;
    } else {
      res.status(409).json({
        error: { code: "UNSUPPORTED", message: "This operation is not supported by the current integration." },
      });
      return;
    }
    const fresh = db.prepare("SELECT * FROM instances WHERE id = ?").get(row.id as string);
    res.json({ data: { instance: fresh } });
  } catch (err) {
    if (err instanceof ProviderError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(502).json({ error: { code: "PROVIDER_ERROR", message: "Infrastructure operation failed." } });
  }
});

export const templatesRouter = Router();
templatesRouter.use(requireAuth);
templatesRouter.get("/", (_req, res) => {
  res.json({ data: { templates: LocalLxcProvider.supportedTemplates() } });
});
