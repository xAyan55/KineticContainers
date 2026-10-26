import type Database from "better-sqlite3";
import { z } from "zod";
import { newId, nowIso } from "../db.js";
import { recordAudit } from "./audit.js";
import { getProviderForNode } from "./virtualization/providerRegistry.js";
import { ProviderError } from "./virtualization/provider.js";

/**
 * VPS provisioning, shared by the panel route (`POST /api/admin/instances`)
 * and the versioned API (`POST /api/v1/instances`, sync or async).
 *
 * Every step verifies the real host before anything is recorded as success:
 * a database row is never treated as proof that a container exists, and a
 * failed create never reports success.
 */

export class HttpError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const createInstanceSchema = z.object({
  name: z.string().trim().min(2).max(63).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Invalid hostname."),
  node_id: z.string().min(1).max(128),
  owner_id: z.string().min(1).max(128),
  template: z.string().min(1).max(64),
  cpu: z.number().int().min(1).max(32),
  memory_mb: z.number().int().min(128).max(131072),
  storage_gb: z.number().int().min(1).max(2000),
  container_id: z.string().trim().min(2).max(63).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
});

export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;

export const reinstallInstanceSchema = z.object({
  template: z.string().trim().min(1).max(64),
  root_password: z.string().min(8, "Root password must be at least 8 characters.").max(128).optional(),
});

export type ReinstallInstanceInput = z.infer<typeof reinstallInstanceSchema>;

export interface ProvisionOptions {
  /** Pre-generated id so an operation record can reference it before work starts. */
  instanceId?: string;
}

export interface ProvisionResult {
  instance: Record<string, unknown>;
  id: string;
  containerId: string;
  status: string;
}

export async function provisionInstance(
  db: Database.Database,
  input: CreateInstanceInput,
  actorId: string,
  opts: ProvisionOptions = {}
): Promise<ProvisionResult> {
  const node = db.prepare("SELECT id, status FROM nodes WHERE id = ?").get(input.node_id) as { id: string; status: string } | undefined;
  if (!node) throw new HttpError("NODE_NOT_FOUND", "Selected node is not registered.", 404);
  const owner = db.prepare("SELECT id FROM users WHERE id = ?").get(input.owner_id) as { id: string } | undefined;
  if (!owner) throw new HttpError("OWNER_NOT_FOUND", "Selected owner does not exist.", 404);

  const provider = getProviderForNode(node.id);
  if (!provider.capabilities.create) {
    throw new HttpError(
      "INFRA_UNCONFIGURED",
      "Container creation is unavailable: no virtualization node is reachable.",
      409
    );
  }

  let supportedTemplates: string[];
  try {
    supportedTemplates = await provider.getSupportedTemplates(node.id);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new HttpError("PROVIDER_ERROR", "Could not check supported templates on node.", 502);
  }
  if (!supportedTemplates.includes(input.template)) {
    throw new HttpError("UNSUPPORTED_TEMPLATE", "Requested template is not supported.", 400);
  }

  const containerId = (input.container_id ?? input.name).trim();
  const clash = db.prepare("SELECT id FROM instances WHERE container_id = ?").get(containerId) as unknown;
  if (clash) throw new HttpError("ID_TAKEN", "Container identifier is already in use.", 409);

  // Admission check against real free host capacity (never invent room).
  try {
    const capacity = await provider.getHostCapacity(node.id);
    const freeMb = capacity.memoryFreeMb ?? capacity.memoryAvailableMb ?? 0;
    const availGb = capacity.diskAvailGb ?? capacity.storageAvailableGb ?? null;
    if (freeMb > 0 && input.memory_mb > freeMb) {
      throw new HttpError(
        "INSUFFICIENT_CAPACITY",
        `Host has only ${freeMb} MB free memory; ${input.memory_mb} MB requested.`,
        409
      );
    }
    if (availGb !== null && availGb !== undefined && input.storage_gb > availGb) {
      throw new HttpError(
        "INSUFFICIENT_CAPACITY",
        `Host has only ${availGb} GB free on the container filesystem; ${input.storage_gb} GB requested.`,
        409
      );
    }
  } catch (err) {
    if (err instanceof ProviderError || err instanceof HttpError) throw err;
    throw new HttpError("PROVIDER_ERROR", "Could not verify host capacity.", 502);
  }

  // Uniqueness against the real host, not just the database.
  try {
    if (await provider.containerExists(node.id, containerId)) {
      throw new HttpError("CONTAINER_EXISTS", "A container with this identifier already exists on the host.", 409);
    }
  } catch (err) {
    if (err instanceof ProviderError && err.code === "LXC_UNAVAILABLE") throw err;
    if (err instanceof HttpError) throw err;
    if (err instanceof ProviderError) throw err;
    throw new HttpError("PROVIDER_ERROR", "Could not verify the host state.", 502);
  }

  // Clean up any stale failed instance with the same containerId or name
  db.prepare("DELETE FROM instances WHERE (container_id = ? OR name = ?) AND status = 'failed'").run(containerId, input.name.trim());

  const id = opts.instanceId ?? newId("vps");
  const now = nowIso();
  db.prepare(
    `INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, template, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?)`
  ).run(id, input.name.trim(), containerId, node.id, owner.id, input.cpu, input.memory_mb, input.storage_gb, input.template, now, now);

  let hostContainerOurs = false;
  try {
    const created = await provider.createContainer(node.id, {
      name: input.name.trim(),
      containerId,
      template: input.template,
      cpu: input.cpu,
      memoryMb: input.memory_mb,
      storageGb: input.storage_gb,
    });
    hostContainerOurs = true;
    // Confirm the real state (and the applied template/resources) before persisting success.
    const liveState = await provider.readContainerState(node.id, containerId).catch(() => "UNKNOWN" as const);
    const status = liveState === "RUNNING" ? "running" : liveState === "STOPPED" ? "stopped" : (created.status ?? "stopped");
    db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
    recordAudit(db, { actorId, action: "instance.create", targetType: "instance", targetId: id, detail: { node: node.id, owner: owner.id, status } });
    const fresh = db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as Record<string, unknown>;
    return { instance: fresh, id, containerId, status };
  } catch (err) {
    // Compensation: only ever touch the container this request created.
    if (hostContainerOurs) {
      try {
        await provider.deleteContainer(node.id, containerId);
        recordAudit(db, { actorId, action: "instance.create_rollback", targetType: "instance", targetId: id, detail: { container_id: containerId } });
      } catch {
        // Leave the record marked failed for manual recovery; report honestly.
      }
    }
    const message = err instanceof Error && err.message ? err.message : "Container creation failed.";
    const code = err instanceof ProviderError ? err.code : err instanceof HttpError ? err.code : "CREATE_FAILED";
    db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?").run("failed", nowIso(), id);
    recordAudit(db, { actorId, action: "instance.create_failed", targetType: "instance", targetId: id, detail: { code, message } });
    if (err instanceof ProviderError || err instanceof HttpError) throw err;
    throw new HttpError("CREATE_FAILED", message, 502);
  }
}

export async function reinstallInstance(
  db: Database.Database,
  instanceId: string,
  input: ReinstallInstanceInput,
  actorId: string
): Promise<{ instance: Record<string, unknown>; status: string }> {
  const instance = db.prepare("SELECT * FROM instances WHERE id = ?").get(instanceId) as Record<string, unknown> | undefined;
  if (!instance) throw new HttpError("NOT_FOUND", "Instance not found.", 404);

  if (instance.status === "suspended") {
    throw new HttpError("INSTANCE_SUSPENDED", "Suspended instances cannot be reinstalled. Lift suspension first.", 403);
  }

  const nodeId = String(instance.node_id);
  const containerId = String(instance.container_id);
  const provider = getProviderForNode(nodeId);

  if (!provider.capabilities.create || !provider.capabilities.remove) {
    throw new HttpError("INFRA_UNCONFIGURED", "Reinstallation is unavailable: virtualization node cannot create/delete containers.", 409);
  }

  let supportedTemplates: string[];
  try {
    supportedTemplates = await provider.getSupportedTemplates(nodeId);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new HttpError("PROVIDER_ERROR", "Could not check supported templates on node.", 502);
  }

  if (!supportedTemplates.includes(input.template)) {
    throw new HttpError("UNSUPPORTED_TEMPLATE", "Requested template is not supported.", 400);
  }

  const oldTemplate = String(instance.template ?? "");

  // Update status to reinstalling
  db.prepare("UPDATE instances SET status = 'reinstalling', updated_at = ? WHERE id = ?").run(nowIso(), instanceId);

  try {
    // 1. Stop if running
    try {
      const state = await provider.readContainerState(nodeId, containerId).catch(() => "UNKNOWN");
      if (state === "RUNNING") {
        await provider.stopContainer(nodeId, containerId);
      }
    } catch {
      // best-effort stop
    }

    // 2. Delete existing container on host
    try {
      if (await provider.containerExists(nodeId, containerId)) {
        await provider.deleteContainer(nodeId, containerId);
      }
    } catch (err) {
      throw err;
    }

    // 3. Create fresh container with the requested template and original resources
    await provider.createContainer(nodeId, {
      name: String(instance.name),
      containerId,
      template: input.template,
      cpu: Number(instance.cpu),
      memoryMb: Number(instance.memory_mb),
      storageGb: Number(instance.storage_gb),
    });

    // 4. If root password requested, set it
    if (input.root_password) {
      await provider.changeRootPassword(nodeId, containerId, input.root_password);
    }

    // 5. Start container
    await provider.startContainer(nodeId, containerId);

    // 6. Confirm real state
    const liveState = await provider.readContainerState(nodeId, containerId).catch(() => "UNKNOWN");
    const status = liveState === "RUNNING" ? "running" : "stopped";

    const now = nowIso();
    db.prepare("UPDATE instances SET template = ?, status = ?, updated_at = ? WHERE id = ?").run(
      input.template,
      status,
      now,
      instanceId
    );

    recordAudit(db, {
      actorId,
      action: "instance.reinstall",
      targetType: "instance",
      targetId: instanceId,
      detail: {
        container_id: containerId,
        old_template: oldTemplate,
        new_template: input.template,
        status,
      },
    });

    const fresh = db.prepare("SELECT * FROM instances WHERE id = ?").get(instanceId) as Record<string, unknown>;
    return { instance: fresh, status };
  } catch (err) {
    db.prepare("UPDATE instances SET status = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), instanceId);
    recordAudit(db, {
      actorId,
      action: "instance.reinstall_failed",
      targetType: "instance",
      targetId: instanceId,
      detail: {
        container_id: containerId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    if (err instanceof ProviderError || err instanceof HttpError) throw err;
    throw new HttpError("REINSTALL_FAILED", err instanceof Error ? err.message : "Reinstallation failed.", 502);
  }
}

