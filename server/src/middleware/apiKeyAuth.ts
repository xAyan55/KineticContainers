import type { NextFunction, Request, Response } from "express";
import { getDb } from "../db.js";
import { recordAuthFailure } from "../api/limits.js";
import { recordKeyUsage, verifyApiKey, type ApiKeyRow } from "../services/apiKeys.js";
import type { AuthUser } from "./auth.js";

export interface ApiPrincipal {
  /** The account that issued the key, loaded fresh on every request. */
  user: AuthUser;
  key: ApiKeyRow;
  scopes: string[];
}

declare global {
  namespace Express {
    interface Request {
      apiPrincipal?: ApiPrincipal;
      /** Per-key / per-client rate limit bucket, set by the API key middleware. */
      apiRateKey?: string;
      /** Request id issued by the `/api/v1` envelope middleware. */
      requestId?: string;
      /** Captured response body, used by the audit/operation recorder. */
      apiResponseBody?: unknown;
      /** Monotonic start time for duration accounting. */
      apiStartedAt?: number;
    }
  }
}

function fail(req: Request, res: Response, status: number, code: string, message: string): void {
  if (status === 401 || status === 403) recordAuthFailure(req.ip);
  res.status(status).json({ error: { code, message } });
}

/**
 * Bearer authentication for `/api/v1`.
 *
 * Order: extract safely → format check → public-id lookup → constant-time
 * hash comparison → expiration → revocation → IP restrictions → issuing
 * account status. Usage metadata is refreshed only after all checks pass.
 * Secrets and Authorization headers are never logged.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header === undefined) {
    next();
    return;
  }
  if (typeof header !== "string") {
    fail(req, res, 401, "INVALID_AUTH_HEADER", "The Authorization header is malformed.");
    return;
  }
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  if (!match) {
    fail(req, res, 401, "INVALID_AUTH_HEADER", 'Authentication must use "Authorization: Bearer <api key>".');
    return;
  }
  const token = match[1];
  if (token.length > 512) {
    fail(req, res, 401, "INVALID_API_KEY", "Invalid API key.");
    return;
  }

  const db = getDb();
  const clientIp = req.ip ?? null;
  const result = verifyApiKey(db, token, clientIp);
  if ("failure" in result) {
    switch (result.failure) {
      case "expired":
        fail(req, res, 401, "API_KEY_EXPIRED", "This API key has expired.");
        return;
      case "revoked":
        fail(req, res, 401, "API_KEY_REVOKED", "This API key has been revoked.");
        return;
      case "ip_not_allowed":
        fail(req, res, 403, "IP_NOT_ALLOWED", "This API key may not be used from the current client IP address.");
        return;
      case "owner_missing":
      case "owner_disabled":
        fail(req, res, 401, "API_KEY_OWNER_UNAVAILABLE", "The account that issued this API key is no longer active.");
        return;
      default:
        // malformed / not_found / mismatch: one generic answer, no enumeration.
        fail(req, res, 401, "INVALID_API_KEY", "Invalid API key.");
        return;
    }
  }

  const owner = db
    .prepare("SELECT id, email, name, role, status, avatar_seed, created_at FROM users WHERE id = ?")
    .get(result.row.created_by) as AuthUser | undefined;
  if (!owner || owner.status !== "active") {
    fail(req, res, 401, "API_KEY_OWNER_UNAVAILABLE", "The account that issued this API key is no longer active.");
    return;
  }

  req.apiPrincipal = { user: owner, key: result.row, scopes: result.scopes };
  req.apiRateKey = `key:${result.row.id}`;
  // Route handlers (requireAuth, audit actors) run as the issuing account,
  // but authorization still needs the key's own scopes — see the scope guard.
  req.user = owner;
  const path = (req.originalUrl ?? req.url).split("?")[0];
  recordKeyUsage(db, result.row.id, `${req.method} ${path}`);
  next();
}

/** 401 helper used by the scope guard when no credential was presented. */
export function unauthenticated(req: Request, res: Response): void {
  fail(req, res, 401, "UNAUTHENTICATED", "This endpoint requires a valid API key.");
}
