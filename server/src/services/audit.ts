import type Database from "better-sqlite3";
import { nowIso, newId } from "../db.js";

export function recordAudit(
  db: Database.Database,
  entry: { actorId?: string | null; action: string; targetType?: string; targetId?: string; detail?: unknown }
): void {
  try {
    db.prepare(
      "INSERT INTO audit_events (id, actor_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      newId("evt"),
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      nowIso()
    );
  } catch {
    // Audit must never break the primary operation.
  }
}

export function toPublicUser(row: Record<string, unknown>): Record<string, unknown> {
  const { password_hash: _ph, ...rest } = row;
  return rest;
}
