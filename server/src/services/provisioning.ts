import type Database from "better-sqlite3";
import { z } from "zod";
import { newId, nowIso } from "../db.js";
import { recordAudit } from "./audit.js";
import {
  containerExistsOnHost,
  checkHostCapacity,
  getHostCapacity,
  getProvider,
  LocalLxcProvider,
  readContainerState,
} from "./virtualization/localAgent.js";
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
  const node = db.prepare("SELECT id FROM nodes WHERE id = ?").get(input.node_id) as { id: string } | undefined;
  if (!node) throw new HttpError("NODE_NOT_FOUND", "Selected node is not registered.", 404);
  const owner = db.prepare("SELECT id FROM users WHERE id = ?").get(input.owner_id) as { id: string } | undefined;
  if (!owner) throw new HttpError("OWNER_NOT_FOUND", "Selected owner does not exist.", 404);
  if (!LocalLxcProvider.supportedTemplates().includes(input.template)) {
    throw new HttpError("UNSUPPORTED_TEMPLATE", "Requested template is not supported.", 400);
  }
  const containerId = (input.container_id ?? input.name).trim();
  const clash = db.prepare("SELECT id FROM instances WHERE container_id = ?").get(containerId) as unknown;
  if (clash) throw new HttpError("ID_TAKEN", "Container identifier is already in use.", 409);

  const provider = getProvider();
  if (!provider.capabilities.create) {
    throw new HttpError(
      "INFRA_UNCONFIGURED",
      "Container creation is unavailable: no virtualization node is reachable.",
      409
    );
  }

  // Admission check against real free host capacity (never invent room).
  try {
    checkHostCapacity(await getHostCapacity(), { memoryMb: input.memory_mb, storageGb: input.storage_gb });
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new HttpError("PROVIDER_ERROR", "Could not verify host capacity.", 502);
  }

  // Uniqueness against the real host, not just the database.
  try {
    if (await containerExistsOnHost(containerId)) {
      throw new HttpError("CONTAINER_EXISTS", "A container with this identifier already exists on the host.", 409);
    }
  } catch (err) {
    if (err instanceof ProviderError && err.code === "LXC_UNAVAILABLE") throw err;
    if (err instanceof HttpError) throw err;
    if (err instanceof ProviderError) throw err;
    throw new HttpError("PROVIDER_ERROR", "Could not verify the host state.", 502);
  }

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
    const liveState = await readContainerState(containerId).catch(() => "UNKNOWN" as const);
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
