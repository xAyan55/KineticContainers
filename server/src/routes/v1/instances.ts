import { Router, type Response } from "express";
import { z } from "zod";
import { getDb, newId } from "../../db.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate, validateQuery } from "../../middleware/validate.js";
import { createInstanceSchema, provisionInstance, HttpError } from "../../services/provisioning.js";
import {
  createOperation,
  finishOperation,
  markOperationRunning,
  runOperation,
  toPublicOperation,
} from "../../services/operations.js";
import { ProviderError } from "../../services/virtualization/provider.js";
import { toPublic as toPublicInstance } from "../instances.js";

/**
 * `/api/v1` instance listing and provisioning.
 *
 * Listing is paginated and filterable, and returns every instance to an
 * administrator while ordinary accounts only ever see their own. Provisioning
 * is the same service the panel uses — optionally recorded as an operation so
 * clients can poll long-running work (sync: 201, async: 202).
 */

export const v1InstancesRouter = Router();
v1InstancesRouter.use(requireAuth);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  status: z.string().trim().max(32).optional(),
  node_id: z.string().trim().max(128).optional(),
  owner_id: z.string().trim().max(128).optional(),
  template: z.string().trim().max(64).optional(),
  q: z.string().trim().max(200).optional(),
});

v1InstancesRouter.get("/", validateQuery(listQuery), (req, res) => {
  const db = getDb();
  const q = (req.validatedQuery ?? {}) as {
    page?: number;
    page_size?: number;
    status?: string;
    node_id?: string;
    owner_id?: string;
    template?: string;
    q?: string;
  };
  const page = q.page ?? 1;
  const pageSize = q.page_size ?? 25;
  const offset = (page - 1) * pageSize;
  const isAdmin = req.user!.role === "admin";
  const where: string[] = [];
  const params: unknown[] = [];
  // Ownership is a server-side rule, not a client-supplied hint.
  const ownerId = isAdmin ? q.owner_id : req.user!.id;
  if (ownerId) {
    where.push("i.owner_id = ?");
    params.push(ownerId);
  }
  if (q.status) {
    where.push("i.status = ?");
    params.push(q.status);
  }
  if (q.node_id) {
    where.push("i.node_id = ?");
    params.push(q.node_id);
  }
  if (q.template) {
    where.push("i.template = ?");
    params.push(q.template);
  }
  if (q.q) {
    where.push("(lower(i.name) LIKE ? OR lower(i.container_id) LIKE ?)");
    params.push(`%${q.q.toLowerCase()}%`, `%${q.q.toLowerCase()}%`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM instances i ${clause}`).get(...(params as never[])) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT i.*, n.name AS node_name FROM instances i LEFT JOIN nodes n ON n.id = i.node_id
       ${clause} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...(params as never[]), pageSize, offset) as Record<string, unknown>[];
  res.json({
    data: {
      instances: rows.map(toPublicInstance),
      pagination: { page, page_size: pageSize, total },
    },
  });
});

const createSchema = createInstanceSchema.extend({
  /** Run provisioning in the background and return an operation to poll (202). */
  async: z.boolean().optional().default(false),
});

function providerFailure(res: Response, err: unknown): void {
  if (err instanceof ProviderError || err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  res.status(502).json({ error: { code: "CREATE_FAILED", message: "Container creation failed." } });
}

v1InstancesRouter.post("/", validate(createSchema), async (req, res) => {
  const db = getDb();
  const input = req.body;
  const wantsAsync = input.async === true;
  const actorId = req.user!.id;
  const actorKeyId = req.apiPrincipal?.key.id ?? null;
  const instanceId = newId("vps");

  if (wantsAsync) {
    const op = createOperation(
      db,
      {
        type: "instance.create",
        instanceId,
        actorId,
        actorKeyId,
        detail: { name: input.name, node_id: input.node_id, owner_id: input.owner_id, template: input.template },
      },
      "queued"
    );
    // Background work: state transitions are only recorded when they happen.
    void (async () => {
      markOperationRunning(db, op.id, "provisioning");
      try {
        const result = await provisionInstance(db, input, actorId, { instanceId });
        finishOperation(db, op.id, { state: "succeeded", detail: { instance_id: result.id, status: result.status } });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Container creation failed.";
        finishOperation(db, op.id, { state: "failed", error: message.slice(0, 500) });
      }
    })();
    res.status(202).json({ data: { operation: toPublicOperation(op) } });
    return;
  }

  try {
    const { operation, result } = await runOperation(
      db,
      {
        type: "instance.create",
        instanceId,
        actorId,
        actorKeyId,
        detail: { name: input.name, node_id: input.node_id, owner_id: input.owner_id, template: input.template },
      },
      () => provisionInstance(db, input, actorId, { instanceId })
    );
    res.status(201).json({ data: { instance: result!.instance, operation } });
  } catch (err) {
    const op = (err as { operation?: unknown }).operation;
    if (err instanceof ProviderError || err instanceof HttpError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message },
        ...(op ? { data: { operation: op } } : {}),
      });
      return;
    }
    res.status(502).json({
      error: { code: "CREATE_FAILED", message: "Container creation failed." },
      ...(op ? { data: { operation: op } } : {}),
    });
  }
});
