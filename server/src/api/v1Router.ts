import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { getDb } from "../db.js";
import { apiKeyAuth, unauthenticated } from "../middleware/apiKeyAuth.js";
import { authThrottle, generalLimiter, isSensitiveRoute, recordAuthFailure, sensitiveLimiter } from "./limits.js";
import { matchRoute, requiredScope, type RouteSpec } from "./registry.js";
import { hasScope } from "./scopes.js";
import { recordAudit } from "../services/audit.js";
import { recordCompletedOperation } from "../services/operations.js";
import { authRouter } from "../routes/auth.js";
import { meRouter } from "../routes/me.js";
import { instancesRouter, templatesRouter } from "../routes/instances.js";
import { nodesRouter } from "../routes/nodes.js";
import { settingsRouter } from "../routes/settings.js";
import { adminUsersRouter } from "../routes/admin/users.js";
import { adminOverviewRouter } from "../routes/admin/overview.js";
import { auditRouter } from "../routes/audit.js";
import { buildCallerApiKeysRouter } from "../routes/apiKeys.js";
import { v1InstancesRouter } from "../routes/v1/instances.js";
import { v1MeRouter, v1MetaRouter } from "../routes/v1/meta.js";
import { v1OperationsRouter } from "../routes/v1/operations.js";

/**
 * The versioned API namespace.
 *
 * Pipeline: request id + response envelope → Bearer authentication →
 * credential-failure throttle → scope guard (fail closed) → rate limits →
 * activity/operation recording → mounted handlers → JSON 404.
 *
 * Handlers are the same routers the panel uses, so browser routes and API
 * routes share one implementation of every business rule. Session cookies are
 * deliberately NOT accepted here: `/api/v1` is Bearer-only.
 */

function requestId(): string {
  return `req_${crypto.randomBytes(9).toString("base64url")}`;
}

/** Adds `meta.request_id` / `error.request_id` and captures the body. */
function envelope(req: Request, res: Response, next: NextFunction): void {
  const id = requestId();
  req.requestId = id;
  req.apiStartedAt = Date.now();
  res.setHeader("X-Request-Id", id);
  const original = res.json.bind(res);
  res.json = ((body: unknown) => {
    let out = body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      if (record.error && typeof record.error === "object") {
        out = { ...record, error: { ...(record.error as Record<string, unknown>), request_id: id } };
      } else if ("data" in record) {
        const meta = (record.meta as Record<string, unknown> | undefined) ?? {};
        out = { data: record.data, meta: { ...meta, request_id: id } };
      }
    }
    req.apiResponseBody = out;
    return original(out);
  }) as Response["json"];
  next();
}

/**
 * Fail-closed scope enforcement. An endpoint that is not in the registry is
 * rejected with 404 before any handler can run.
 */
function scopeGuard(req: Request, res: Response, next: NextFunction): void {
  const match = matchRoute(req.method, req.path);
  if (!match) {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: `Unknown API endpoint: ${req.method} ${req.path}` },
    });
    return;
  }
  const scope = requiredScope(match.spec, req);
  if (scope === null) {
    next();
    return;
  }
  if (!req.apiPrincipal) {
    unauthenticated(req, res);
    return;
  }
  if (!hasScope(req.apiPrincipal.scopes, scope)) {
    recordAuthFailure(req.ip);
    res.status(403).json({
      error: {
        code: "INSUFFICIENT_SCOPE",
        message: "This API key does not have permission to perform this operation.",
        details: [{ path: "scope", message: `Requires the "${scope}" scope.` }],
      },
    });
    return;
  }
  next();
}

/** Operations worth logging from the real HTTP outcome of a request. */
const OPERATION_ROUTES: { method: string; match: RegExp; type: string; idParam?: "id" }[] = [
  { method: "POST", match: /^\/instances\/([^/]+)\/actions$/, type: "instance.action", idParam: "id" },
  { method: "POST", match: /^\/instances\/([^/]+)\/repair$/, type: "instance.repair", idParam: "id" },
  { method: "PATCH", match: /^\/instances\/([^/]+)\/resources$/, type: "instance.resources_update", idParam: "id" },
  { method: "DELETE", match: /^\/instances\/([^/]+)$/, type: "instance.delete", idParam: "id" },
  { method: "POST", match: /^\/nodes$/, type: "node.create" },
  { method: "DELETE", match: /^\/nodes\/([^/]+)$/, type: "node.delete", idParam: "id" },
];

function sanitize(message: unknown): string | null {
  if (typeof message !== "string" || message.length === 0) return null;
  return message.replace(/kct_live_[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

/**
 * Record API activity and completed infrastructure operations. Runs after the
 * response is finished, never affects it, and never stores secrets.
 */
function activityRecorder(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    try {
      const method = req.method.toUpperCase();
      const match = matchRoute(method, req.path);
      const body = req.apiResponseBody as { data?: Record<string, unknown>; error?: { code?: string; message?: string } } | undefined;
      const db = getDb();

      if (match) {
        const spec: RouteSpec = match.spec;
        // Audit every mutating API call; reads stay out of the log.
        if (method !== "GET" && method !== "HEAD") {
          recordAudit(db, {
            actorId: req.user?.id ?? null,
            action: "api.request",
            targetType: "api",
            targetId: `${method} /api/v1${spec.path}`,
            detail: {
              status: res.statusCode,
              scope: spec.scope,
              request_id: req.requestId ?? null,
              key_id: req.apiPrincipal?.key.id ?? null,
              params: match.params,
            },
          });
        }

        const operation = OPERATION_ROUTES.find((entry) => entry.method === method && entry.match.test(req.path));
        const alreadyLogged = Boolean(body?.data && "operation" in body.data);
        if (operation && !alreadyLogged) {
          const targetId = operation.idParam ? (match.params[operation.idParam] ?? null) : null;
          const failed = res.statusCode >= 400;
          const isInstanceOp = operation.type.startsWith("instance.");
          const requestedAction = (req.body as { action?: unknown } | undefined)?.action;
          const type =
            operation.type === "instance.action" && typeof requestedAction === "string"
              ? `instance.${requestedAction.replace(/[^a-z]/gi, "").slice(0, 24)}`
              : operation.type;
          recordCompletedOperation(db, {
            type,
            state: failed ? "failed" : "succeeded",
            instanceId: isInstanceOp ? targetId : null,
            nodeId: !isInstanceOp && targetId ? targetId : null,
            actorId: req.user?.id ?? null,
            actorKeyId: req.apiPrincipal?.key.id ?? null,
            error: failed ? (sanitize(body?.error?.message) ?? body?.error?.code ?? "Request failed.") : null,
            detail: { method, path: `/api/v1${spec.path}`, status: res.statusCode },
            startedAt: req.apiStartedAt ? new Date(req.apiStartedAt) : new Date(),
          });
        }
      }

      if (isSensitiveRoute(method, req.path) && res.statusCode >= 400 && !req.apiPrincipal) {
        recordAuthFailure(req.ip);
      }
    } catch {
      // Recording must never affect a response that was already sent.
    }
  });
  next();
}

export function createV1Router(): Router {
  const v1 = Router();

  v1.use(envelope);
  v1.use(authThrottle);
  v1.use(apiKeyAuth);
  v1.use(scopeGuard);
  v1.use(generalLimiter);
  v1.use(sensitiveLimiter);
  v1.use(activityRecorder);

  // Application metadata and identity.
  v1.use("/", v1MetaRouter);
  v1.use("/me", v1MeRouter);
  // Profile edits (PATCH /me, POST /me/password) reuse the panel handlers.
  v1.use("/me", meRouter);
  // Registration keeps the panel's server-side policy (off by default).
  v1.use("/auth", authRouter);

  // Instances: paginated list + provisioning first, then the shared handlers.
  v1.use("/instances", v1InstancesRouter);
  v1.use("/instances", instancesRouter);
  v1.use("/templates", templatesRouter);

  // Infrastructure, accounts, settings, audit, operations, API keys.
  v1.use("/nodes", nodesRouter);
  v1.use("/users", adminUsersRouter);
  v1.use("/overview", adminOverviewRouter);
  v1.use("/settings", settingsRouter);
  v1.use("/audit", auditRouter);
  v1.use("/operations", v1OperationsRouter);
  v1.use("/api-keys", buildCallerApiKeysRouter());

  // Terminal JSON 404 (never the SPA fallback).
  v1.use((req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: `Unknown API endpoint: ${req.method} ${req.path}` },
    });
  });

  return v1;
}
