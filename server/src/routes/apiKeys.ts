import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { FULL_ACCESS, isSubsetOf, scopeCatalogue } from "../api/scopes.js";
import {
  ApiKeyValidationError,
  canManageKey,
  createApiKey,
  getApiKeyRow,
  getPublicApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateApiKey,
  type ListVisibility,
} from "../services/apiKeys.js";

/**
 * One implementation of API key management, mounted twice with different
 * visibility rules:
 *
 *  - `buildAdminApiKeysRouter()`  — session + administrator. Manages every
 *    key on the installation (used by the panel's API Keys page).
 *  - `buildCallerApiKeysRouter()` — Bearer + `api_keys:*` scopes. Manages
 *    only keys created by the calling key, can never grant a scope it does
 *    itself hold, and cannot mint a child that outlives its own expiry.
 *
 * Neither route ever returns a stored secret; the plaintext key exists only
 * in the response to a create or rotate call.
 */

export interface KeyRouterContext {
  visibility: ListVisibility;
  /** Set for API-key callers: the calling key's id (lineage + restrictions). */
  callerKeyId?: string | null;
  /** Set for API-key callers: the calling key's own scopes. */
  callerScopes?: string[];
  /** Set for API-key callers: the calling key's expiration, which bounds children. */
  callerExpiresAt?: string | null;
  /** Audit detail marker ("session" or the calling key id). */
  actorSource: string;
}

type ContextFactory = (req: Request) => KeyRouterContext;

function fail(res: Response, err: unknown): void {
  if (err instanceof ApiKeyValidationError) {
    res.status(400).json({ error: { code: "VALIDATION", message: err.message, details: err.details } });
    return;
  }
  res.status(500).json({ error: { code: "INTERNAL", message: "API key operation failed." } });
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "API key not found." } });
}

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().trim().max(200).optional(),
  status: z.enum(["active", "expired", "revoked", "all"]).optional(),
  created_by: z.string().trim().max(128).optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z.array(z.string().trim().min(1).max(64)).min(1).max(64),
  expires_at: z.union([z.string().trim().max(40), z.null()]).optional(),
  ip_allowlist: z.array(z.string().trim().max(64)).max(64).optional(),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    scopes: z.array(z.string().trim().min(1).max(64)).min(1).max(64).optional(),
    expires_at: z.union([z.string().trim().max(40), z.null()]).optional(),
    ip_allowlist: z.array(z.string().trim().max(64)).max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided." });

const rotateSchema = z.object({ revoke_old: z.boolean().optional().default(false) });

function assertNoEscalation(ctx: KeyRouterContext, scopes: string[] | undefined): void {
  if (ctx.callerScopes === undefined || scopes === undefined) return;
  if (!isSubsetOf(scopes, ctx.callerScopes)) {
    throw new ApiKeyValidationError([
      { path: "scopes", message: "A key cannot grant a scope it does not itself hold." },
    ]);
  }
}

function assertExpiryBound(ctx: KeyRouterContext, expiresAt: string | null | undefined): void {
  if (ctx.callerExpiresAt === undefined || expiresAt === undefined) return;
  if (ctx.callerExpiresAt === null) return; // parent key never expires
  const parentMs = Date.parse(ctx.callerExpiresAt);
  if (!Number.isFinite(parentMs)) return; // unparsable parent expiry (defensive)
  const requestedMs = expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(expiresAt);
  if (!Number.isFinite(requestedMs) || requestedMs > parentMs) {
    throw new ApiKeyValidationError([
      { path: "expires_at", message: "A key cannot outlive the key that created it." },
    ]);
  }
}

/** Load a key the caller is allowed to see; otherwise 404 (no enumeration). */
function findVisible(req: Request, ctx: KeyRouterContext): ReturnType<typeof getApiKeyRow> {
  const row = getApiKeyRow(getDb(), req.params.id);
  if (!row) return undefined;
  if (!canManageKey(row, ctx.visibility, ctx.callerKeyId ?? undefined)) return undefined;
  return row;
}

export function buildApiKeysRouter(context: ContextFactory): Router {
  const router = Router();

  router.get("/", validateQuery(listQuery), (req, res) => {
    const ctx = context(req);
    const q = (req.validatedQuery ?? {}) as {
      page?: number;
      page_size?: number;
      q?: string;
      status?: "active" | "expired" | "revoked" | "all";
      created_by?: string;
    };
    const result = listApiKeys(getDb(), {
      page: q.page,
      pageSize: q.page_size,
      search: q.q,
      status: q.status ?? "all",
      visibility: ctx.visibility.mode === "all" ? { mode: "all", createdBy: q.created_by } : ctx.visibility,
    });
    res.json({ data: { keys: result.keys, pagination: result.pagination } });
  });

  router.post("/", validate(createSchema), (req, res) => {
    const ctx = context(req);
    const db = getDb();
    try {
      assertNoEscalation(ctx, req.body.scopes as string[]);
      assertExpiryBound(ctx, (req.body.expires_at as string | null | undefined) ?? null);
      const created = createApiKey(db, {
        name: req.body.name,
        scopes: req.body.scopes,
        createdBy: req.user!.id,
        createdByKey: ctx.callerKeyId ?? null,
        expiresAt: req.body.expires_at ?? null,
        ipAllowlist: req.body.ip_allowlist ?? [],
      });
      recordAudit(db, {
        actorId: req.user!.id,
        action: "api_key.create",
        targetType: "api_key",
        targetId: created.key.id,
        detail: {
          name: created.key.name,
          scopes: created.key.scopes,
          expires_at: created.key.expires_at,
          via: ctx.actorSource,
        },
      });
      res.status(201).json({ data: { key: created.key, secret: created.secret } });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/:id", (req, res) => {
    const ctx = context(req);
    const key = findVisible(req, ctx) ? getPublicApiKey(getDb(), req.params.id) : null;
    if (!key) {
      notFound(res);
      return;
    }
    res.json({ data: { key } });
  });

  router.patch("/:id", validate(updateSchema), (req, res) => {
    const ctx = context(req);
    const db = getDb();
    const row = findVisible(req, ctx);
    if (!row) {
      notFound(res);
      return;
    }
    try {
      assertNoEscalation(ctx, req.body.scopes as string[] | undefined);
      assertExpiryBound(ctx, req.body.expires_at as string | null | undefined);
      const updated = updateApiKey(db, row.id, {
        name: req.body.name,
        scopes: req.body.scopes,
        expiresAt: req.body.expires_at,
        ipAllowlist: req.body.ip_allowlist,
      });
      recordAudit(db, {
        actorId: req.user!.id,
        action: "api_key.update",
        targetType: "api_key",
        targetId: row.id,
        detail: { name: updated.name, scopes: updated.scopes, expires_at: updated.expires_at, via: ctx.actorSource },
      });
      res.json({ data: { key: updated } });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/:id/rotate", validate(rotateSchema), (req, res) => {
    const ctx = context(req);
    const db = getDb();
    const row = findVisible(req, ctx);
    if (!row) {
      notFound(res);
      return;
    }
    try {
      const inheritedScopes = JSON.parse(row.scopes) as string[];
      assertNoEscalation(ctx, inheritedScopes);
      assertExpiryBound(ctx, row.expires_at);
      const rotated = rotateApiKey(db, row.id, {
        revokeOld: req.body.revoke_old === true,
        actorId: req.user!.id,
        callerKeyId: ctx.callerKeyId ?? null,
      });
      recordAudit(db, {
        actorId: req.user!.id,
        action: "api_key.rotate",
        targetType: "api_key",
        targetId: rotated.key.id,
        detail: { rotated_from: row.id, revoked_old: req.body.revoke_old === true, via: ctx.actorSource },
      });
      res.status(201).json({ data: { key: rotated.key, secret: rotated.secret, previous_key: getPublicApiKey(db, row.id) } });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/:id", (req, res) => {
    const ctx = context(req);
    const db = getDb();
    const row = findVisible(req, ctx);
    if (!row) {
      notFound(res);
      return;
    }
    const key = revokeApiKey(db, row.id);
    recordAudit(db, {
      actorId: req.user!.id,
      action: "api_key.revoke",
      targetType: "api_key",
      targetId: row.id,
      detail: { name: row.name, via: ctx.actorSource },
    });
    res.json({ data: { key } });
  });

  return router;
}

/** Session-authenticated, administrator-only: manages every key. */
export function buildAdminApiKeysRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireAdmin);
  /** The scope catalogue — one source of truth for UI, docs, and enforcement. */
  router.get("/scopes", (_req, res) => res.json({ data: scopeCatalogue() }));
  router.use(
    buildApiKeysRouter(() => ({ visibility: { mode: "all" }, actorSource: "session" }))
  );
  return router;
}

/**
 * Bearer-authenticated: manages only keys created by the calling key and
 * can never widen the calling key's own permissions.
 */
export function buildCallerApiKeysRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireAdmin);
  router.use((req, res, next) => {
    const principal = req.apiPrincipal;
    if (!principal) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "This endpoint requires a valid API key." } });
      return;
    }
    next();
  });
  router.get("/scopes", (_req, res) => res.json({ data: scopeCatalogue() }));
  router.use(
    buildApiKeysRouter((req) => ({
      visibility: { mode: "children", keyId: req.apiPrincipal!.key.id },
      callerKeyId: req.apiPrincipal!.key.id,
      callerScopes: req.apiPrincipal!.scopes,
      callerExpiresAt: req.apiPrincipal!.key.expires_at,
      actorSource: req.apiPrincipal!.key.id,
    }))
  );
  return router;
}

export const FULL_ACCESS_SCOPE = FULL_ACCESS;
