import { Router } from "express";
import { getDb } from "../../db.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { getProvider } from "../../services/virtualization/localAgent.js";

export const adminOverviewRouter = Router();
adminOverviewRouter.use(requireAuth, requireAdmin);

adminOverviewRouter.get("/", async (_req, res) => {
  const db = getDb();
  const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  const total = (db.prepare("SELECT COUNT(*) AS n FROM instances").get() as { n: number }).n;
  const running = (db.prepare("SELECT COUNT(*) AS n FROM instances WHERE status = 'running'").get() as { n: number }).n;
  const stopped = (db.prepare("SELECT COUNT(*) AS n FROM instances WHERE status = 'stopped'").get() as { n: number }).n;
  const nodes = db.prepare("SELECT id, name, endpoint, status, last_seen_at, updated_at FROM nodes ORDER BY created_at ASC").all();
  const recentEvents = db
    .prepare("SELECT id, actor_id, action, target_type, target_id, created_at FROM audit_events ORDER BY created_at DESC LIMIT 15")
    .all();

  // Live utilization only when the integration can report it honestly.
  let infra: Record<string, unknown> = { configured: nodes.length > 0, live: null as unknown, error: null as unknown };
  if (nodes.length > 0) {
    try {
      const provider = getProvider();
      const first = nodes[0] as { id: string };
      const status = await provider.getNodeStatus(first.id);
      infra = { configured: true, live: status, error: null };
    } catch (err) {
      infra = {
        configured: true,
        live: null,
        error: err instanceof Error ? err.message : "Infrastructure integration unavailable.",
      };
    }
  } else {
    infra = { configured: false, live: null, error: "No virtualization node configured." };
  }

  const migration = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  res.json({
    data: {
      users_total: users,
      containers_total: total,
      containers_running: running,
      containers_stopped: stopped,
      nodes_total: (nodes as unknown[]).length,
      nodes,
      utilization: (infra.live as Record<string, unknown> | null) ?? null,
      infra_status: infra.error ?? "ok",
      infra_configured: infra.configured,
      recent_events: recentEvents,
      migration_version: migration.v ?? 0,
      app_version: process.env.npm_package_version ?? "0.1.0",
    },
  });
});
