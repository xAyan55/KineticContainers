import { Router } from "express";
import { z } from "zod";
import { getDb, newId, nowIso } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { getProvider } from "../services/virtualization/localAgent.js";

export const nodesRouter = Router();
nodesRouter.use(requireAuth, requireAdmin);

nodesRouter.get("/", (_req, res) => {
  const db = getDb();
  // Never expose stored tokens.
  const nodes = db
    .prepare("SELECT id, name, endpoint, status, last_seen_at, capabilities, created_at, updated_at FROM nodes ORDER BY created_at ASC")
    .all();
  res.json({ data: { nodes, provider: getProvider().kind } });
});

const nodeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  endpoint: z.string().trim().min(1).max(255),
  api_token: z.string().max(1024).optional().default(""),
});

nodesRouter.post("/", validate(nodeSchema), (req, res) => {
  const db = getDb();
  const id = newId("node");
  const now = nowIso();
  db.prepare(
    "INSERT INTO nodes (id, name, endpoint, api_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'unknown', ?, ?)"
  ).run(id, req.body.name.trim(), req.body.endpoint.trim(), String(req.body.api_token ?? ""), now, now);
  recordAudit(db, { actorId: req.user!.id, action: "node.register", targetType: "node", targetId: id });
  res.status(201).json({ data: { node: { id, name: req.body.name, endpoint: req.body.endpoint, status: "unknown" } } });
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
