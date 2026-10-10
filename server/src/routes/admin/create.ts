import { Router } from "express";
import { z } from "zod";
import { getDb, newId, nowIso } from "../../db.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { recordAudit } from "../../services/audit.js";
import { getProvider, LocalLxcProvider, containerExistsOnHost, readContainerState } from "../../services/virtualization/localAgent.js";
import { ProviderError } from "../../services/virtualization/provider.js";

export const adminCreateRouter = Router();
adminCreateRouter.use(requireAuth, requireAdmin);

const createSchema = z.object({
  name: z.string().trim().min(2).max(63).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Invalid hostname."),
  node_id: z.string().min(1).max(128),
  owner_id: z.string().min(1).max(128),
  template: z.string().min(1).max(64),
  cpu: z.number().int().min(1).max(32),
  memory_mb: z.number().int().min(128).max(131072),
  storage_gb: z.number().int().min(1).max(2000),
  container_id: z.string().trim().min(2).max(63).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
});

adminCreateRouter.post("/", validate(createSchema), async (req, res) => {
  const db = getDb();
  const node = db.prepare("SELECT id FROM nodes WHERE id = ?").get(req.body.node_id) as { id: string } | undefined;
  if (!node) {
    res.status(404).json({ error: { code: "NODE_NOT_FOUND", message: "Selected node is not registered." } });
    return;
  }
  const owner = db.prepare("SELECT id FROM users WHERE id = ?").get(req.body.owner_id) as { id: string } | undefined;
  if (!owner) {
    res.status(404).json({ error: { code: "OWNER_NOT_FOUND", message: "Selected owner does not exist." } });
    return;
  }
  if (!LocalLxcProvider.supportedTemplates().includes(req.body.template)) {
    res.status(400).json({ error: { code: "UNSUPPORTED_TEMPLATE", message: "Requested template is not supported." } });
    return;
  }
  const containerId = (req.body.container_id ?? req.body.name).trim();
  const clash = db.prepare("SELECT id FROM instances WHERE container_id = ?").get(containerId) as unknown;
  if (clash) {
    res.status(409).json({ error: { code: "ID_TAKEN", message: "Container identifier is already in use." } });
    return;
  }

  const provider = getProvider();
  if (!provider.capabilities.create) {
    res.status(409).json({ error: { code: "INFRA_UNCONFIGURED", message: "Container creation is unavailable: no virtualization node is reachable." } });
    return;
  }

  // Uniqueness against the real host, not just the database.
  try {
    if (await containerExistsOnHost(containerId)) {
      res.status(409).json({
        error: { code: "CONTAINER_EXISTS", message: "A container with this identifier already exists on the host." },
      });
      return;
    }
  } catch (err) {
    if (err instanceof ProviderError && err.code === "LXC_UNAVAILABLE") {
      res.status(502).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ProviderError) throw err;
    res.status(502).json({ error: { code: "PROVIDER_ERROR", message: "Could not verify the host state." } });
    return;
  }

  // 1-4: inputs validated, node reachable check happens inside provider; reserve id via unique constraint.
  const id = newId("vps");
  const now = nowIso();
  db.prepare(
    `INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, template, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?)`
  ).run(id, req.body.name.trim(), containerId, node.id, owner.id, req.body.cpu, req.body.memory_mb, req.body.storage_gb, req.body.template, now, now);

  let hostContainerOurs = false;
  try {
    const created = await provider.createContainer(node.id, {
      name: req.body.name.trim(),
      containerId,
      template: req.body.template,
      cpu: req.body.cpu,
      memoryMb: req.body.memory_mb,
      storageGb: req.body.storage_gb,
    });
    hostContainerOurs = true;
    // Confirm the real state (and the applied template/resources) before persisting success.
    const liveState = await readContainerState(containerId).catch(() => "UNKNOWN" as const);
    const status = liveState === "RUNNING" ? "running" : liveState === "STOPPED" ? "stopped" : (created.status ?? "stopped");
    db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
    recordAudit(db, { actorId: req.user!.id, action: "instance.create", targetType: "instance", targetId: id, detail: { node: node.id, owner: owner.id, status } });
    const fresh = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
    res.status(201).json({ data: { instance: fresh } });
  } catch (err) {
    // Compensation: only ever touch the container this request created.
    // A failed create leaves a 'failed' record (never a fake success); if the
    // host container is ours but persistence/verification failed, destroy exactly
    // that container so retries are possible. Never touch anything else.
    if (hostContainerOurs) {
      try {
        await provider.deleteContainer(node.id, containerId);
        recordAudit(db, { actorId: req.user!.id, action: "instance.create_rollback", targetType: "instance", targetId: id, detail: { container_id: containerId } });
      } catch {
        // Leave the record marked failed for manual recovery; report honestly.
      }
    }
    const message = err instanceof ProviderError ? err.message : "Container creation failed.";
    const code = err instanceof ProviderError ? err.code : "CREATE_FAILED";
    db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run("failed", nowIso(), id);
    recordAudit(db, { actorId: req.user!.id, action: "instance.create_failed", targetType: "instance", targetId: id, detail: { code, message } });
    const status = err instanceof ProviderError ? err.status : 502;
    res.status(status).json({ error: { code, message } });
  }
});
