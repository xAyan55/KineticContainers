import { Router } from "express";
import { z } from "zod";
import { getDb } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateQuery } from "../../middleware/validate.js";
import { getOperationRow, listOperations, toPublicOperation, type OperationState } from "../../services/operations.js";

/** Read access to the operation log: status, timing, and sanitized results. */

export const v1OperationsRouter = Router();
v1OperationsRouter.use(requireAuth);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "all"]).optional(),
  type: z.string().trim().max(64).optional(),
  instance_id: z.string().trim().max(128).optional(),
  actor_id: z.string().trim().max(128).optional(),
});

v1OperationsRouter.get("/", validateQuery(listQuery), (req, res) => {
  const db = getDb();
  const q = (req.validatedQuery ?? {}) as {
    page?: number;
    page_size?: number;
    state?: OperationState | "all";
    type?: string;
    instance_id?: string;
    actor_id?: string;
  };
  const result = listOperations(db, {
    page: q.page,
    pageSize: q.page_size,
    state: q.state ?? "all",
    type: q.type,
    instanceId: q.instance_id,
    actorId: q.actor_id,
  });
  res.json({ data: { operations: result.operations, pagination: result.pagination } });
});

v1OperationsRouter.get("/:id", (req, res) => {
  const row = getOperationRow(getDb(), req.params.id);
  if (!row) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Operation not found." } });
    return;
  }
  res.json({ data: { operation: toPublicOperation(row) } });
});
