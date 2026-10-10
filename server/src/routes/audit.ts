import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { validateQuery } from "../middleware/validate.js";

/**
 * Sanitized audit log reads. Mounted twice:
 *   - `/api/admin/audit` (session, administrator)
 *   - `/api/v1/audit`    (Bearer, scope `audit:read`)
 *
 * Events never contain credentials: stored details are redacted defensively
 * on write and again on read, and Authorization headers are never recorded.
 */

export const auditRouter = Router();

const SENSITIVE_KEY = /pass|secret|token|credential|authorization|key_hash|api_key/i;
const MAX_DETAIL_CHARS = 4000;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function parseDetail(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return redact(parsed);
  } catch {
    return null;
  }
}

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  action: z.string().trim().max(120).optional(),
  actor_id: z.string().trim().max(128).optional(),
  target_type: z.string().trim().max(64).optional(),
  target_id: z.string().trim().max(128).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
});

auditRouter.get("/events", validateQuery(querySchema), (req, res) => {
  const db = getDb();
  const q = req.validatedQuery ?? {};
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.page_size ?? 25) || 25));
  const offset = (page - 1) * pageSize;
  const where: string[] = [];
  const params: unknown[] = [];
  const push = (clause: string, ...values: unknown[]): void => {
    where.push(clause);
    params.push(...values);
  };
  if (q.action) push("e.action = ?", q.action);
  if (q.actor_id) push("e.actor_id = ?", q.actor_id);
  if (q.target_type) push("e.target_type = ?", q.target_type);
  if (q.target_id) push("e.target_id = ?", q.target_id);
  if (q.from) push("e.created_at >= ?", q.from);
  if (q.to) push("e.created_at <= ?", q.to);
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_events e ${clause}`).get(...(params as never[])) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT e.*, u.email AS actor_email, u.name AS actor_name
       FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
       ${clause} ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`
    )
    .all(...(params as never[]), pageSize, offset) as Record<string, unknown>[];
  res.json({
    data: {
      events: rows.map((row) => ({
        id: row.id,
        actor_id: row.actor_id,
        actor_email: row.actor_email ?? null,
        actor_name: row.actor_name ?? null,
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        detail: parseDetail(row.detail),
        created_at: row.created_at,
      })),
      pagination: { page, page_size: pageSize, total },
    },
  });
});
