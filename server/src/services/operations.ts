import type Database from "better-sqlite3";
import { newId, nowIso } from "../db.js";

/**
 * Operation log for long-running infrastructure work.
 *
 * States are only ever recorded when they are actually true:
 *   queued → running → succeeded | failed   (cancelled is reserved and unused,
 *   because the underlying host operations cannot be safely aborted)
 *
 * Rows live in SQLite, so status survives a process restart; anything left
 * `queued`/`running` when the app boots is marked failed as interrupted,
 * never silently left pending.
 */

export type OperationState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface OperationRow {
  id: string;
  type: string;
  state: OperationState;
  instance_id: string | null;
  node_id: string | null;
  actor_id: string | null;
  actor_key_id: string | null;
  detail: string | null;
  error: string | null;
  progress: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface PublicOperation {
  id: string;
  type: string;
  state: OperationState;
  instance_id: string | null;
  node_id: string | null;
  actor_id: string | null;
  actor_key_id: string | null;
  detail: Record<string, unknown> | null;
  error: string | null;
  progress: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function toPublicOperation(row: OperationRow): PublicOperation {
  const finished = row.finished_at ? new Date(row.finished_at).getTime() : null;
  const created = new Date(row.created_at).getTime();
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    instance_id: row.instance_id,
    node_id: row.node_id,
    actor_id: row.actor_id,
    actor_key_id: row.actor_key_id,
    detail: parseDetail(row.detail),
    error: row.error,
    progress: row.progress,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: finished !== null && Number.isFinite(created) ? finished - created : null,
  };
}

export interface StartOperationInput {
  type: string;
  instanceId?: string | null;
  nodeId?: string | null;
  actorId?: string | null;
  actorKeyId?: string | null;
  detail?: Record<string, unknown>;
}

export function createOperation(db: Database.Database, input: StartOperationInput, state: OperationState = "queued"): OperationRow {
  const id = newId("op");
  const now = nowIso();
  db.prepare(
    `INSERT INTO operations (id, type, state, instance_id, node_id, actor_id, actor_key_id, detail, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.type,
    state,
    input.instanceId ?? null,
    input.nodeId ?? null,
    input.actorId ?? null,
    input.actorKeyId ?? null,
    input.detail ? JSON.stringify(input.detail) : null,
    now,
    state === "running" || state === "succeeded" || state === "failed" ? now : null
  );
  return db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow;
}

export function markOperationRunning(db: Database.Database, id: string, progress?: string): void {
  db.prepare("UPDATE operations SET state = 'running', started_at = COALESCE(started_at, ?), progress = COALESCE(?, progress) WHERE id = ?").run(
    nowIso(),
    progress ?? null,
    id
  );
}

export function finishOperation(
  db: Database.Database,
  id: string,
  outcome: { state: "succeeded" | "failed" | "cancelled"; detail?: Record<string, unknown>; error?: string | null; progress?: string | null }
): void {
  const existing = db.prepare("SELECT detail FROM operations WHERE id = ?").get(id) as { detail: string | null } | undefined;
  const merged = { ...(existing?.detail ? parseDetail(existing.detail) : {}), ...(outcome.detail ?? {}) };
  db.prepare(
    "UPDATE operations SET state = ?, finished_at = ?, started_at = COALESCE(started_at, ?), detail = ?, error = ?, progress = COALESCE(?, progress) WHERE id = ?"
  ).run(outcome.state, nowIso(), nowIso(), Object.keys(merged).length > 0 ? JSON.stringify(merged) : null, outcome.error ?? null, outcome.progress ?? null, id);
}

/** Boot-time honesty: work that was interrupted by a restart is failed, not pending. */
export function reapInterruptedOperations(db: Database.Database): number {
  const result = db
    .prepare(
      `UPDATE operations SET state = 'failed', finished_at = ?, error = 'Interrupted by a server restart before completion.'
       WHERE state IN ('queued','running')`
    )
    .run(nowIso());
  return result.changes;
}

export function getOperationRow(db: Database.Database, id: string): OperationRow | undefined {
  return db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow | undefined;
}

export interface CompletedOperationInput extends StartOperationInput {
  state: "succeeded" | "failed";
  error?: string | null;
  /** Request start, so the recorded duration reflects the real request. */
  startedAt?: Date;
}

/**
 * Record an operation that already finished inside a single request (power
 * actions, deletes, repairs, resource changes). The state comes from the real
 * HTTP outcome — a 5xx from the provider is `failed`, never `succeeded`.
 */
export function recordCompletedOperation(db: Database.Database, input: CompletedOperationInput): OperationRow | null {
  try {
    const id = newId("op");
    const started = input.startedAt ?? new Date();
    const finished = new Date();
    db.prepare(
      `INSERT INTO operations (id, type, state, instance_id, node_id, actor_id, actor_key_id, detail, error, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.type,
      input.state,
      input.instanceId ?? null,
      input.nodeId ?? null,
      input.actorId ?? null,
      input.actorKeyId ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
      input.error ?? null,
      started.toISOString(),
      started.toISOString(),
      finished.toISOString()
    );
    return db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow;
  } catch {
    // The operation log must never break the response that already succeeded.
    return null;
  }
}

export interface ListOperationsOptions {
  page?: number;
  pageSize?: number;
  state?: OperationState | "all";
  type?: string;
  instanceId?: string;
  actorId?: string;
}

export interface ListOperationsResult {
  operations: PublicOperation[];
  pagination: { page: number; page_size: number; total: number };
}

export function listOperations(db: Database.Database, opts: ListOperationsOptions): ListOperationsResult {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
  const offset = (page - 1) * pageSize;
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.state && opts.state !== "all") {
    where.push("state = ?");
    params.push(opts.state);
  }
  if (opts.type) {
    where.push("type = ?");
    params.push(opts.type);
  }
  if (opts.instanceId) {
    where.push("instance_id = ?");
    params.push(opts.instanceId);
  }
  if (opts.actorId) {
    where.push("actor_id = ?");
    params.push(opts.actorId);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM operations ${clause}`).get(...(params as never[])) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM operations ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...(params as never[]), pageSize, offset) as OperationRow[];
  return { operations: rows.map(toPublicOperation), pagination: { page, page_size: pageSize, total } };
}

export interface RunOperationResult<T> {
  operation: PublicOperation;
  result?: T;
}

/**
 * Run work inside an operation record: created queued, marked running,
 * then finished with the true outcome. Never swallows the original error —
 * the caller still sees it, and the operation keeps a sanitized message.
 */
export async function runOperation<T>(
  db: Database.Database,
  input: StartOperationInput,
  work: () => Promise<T>
): Promise<RunOperationResult<T>> {
  const op = createOperation(db, input, "running");
  try {
    const result = await work();
    finishOperation(db, op.id, { state: "succeeded" });
    return { operation: toPublicOperation(getOperationRow(db, op.id) ?? op), result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Operation failed.";
    finishOperation(db, op.id, { state: "failed", error: message.slice(0, 500) });
    throw Object.assign(err instanceof Error ? err : new Error(message), {
      operation: toPublicOperation(getOperationRow(db, op.id) ?? op),
    });
  }
}
