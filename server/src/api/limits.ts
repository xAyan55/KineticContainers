import type { NextFunction, Request, Response } from "express";

/**
 * Small, dependency-free fixed-window limiters for `/api/v1`.
 *
 * Two independent budgets:
 *   - general:   every authenticated call, keyed by API key (or client IP
 *                when no key was presented)
 *   - sensitive: provisioning, deletion, credential, node, and key endpoints
 *
 * A third counter tracks repeated credential failures per client IP so a bad
 * key cannot be brute-forced without hitting `429` first.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function generalRateLimit(): number {
  return envInt("API_RATE_LIMIT_MAX", 120);
}

export function sensitiveRateLimit(): number {
  return envInt("API_SENSITIVE_RATE_LIMIT_MAX", 20);
}

export function authFailureLimit(): number {
  return envInt("API_AUTH_FAILURE_LIMIT", 30);
}

const WINDOW_MS = 60_000;
const AUTH_WINDOW_MS = 5 * 60_000;

const buckets = new Map<string, Bucket>();
const authFailures = new Map<string, Bucket>();
const memoryCeiling = 5_000;

function prune(map: Map<string, Bucket>, now: number): void {
  if (map.size < memoryCeiling) return;
  for (const [key, bucket] of map) {
    if (bucket.resetAt <= now) map.delete(key);
  }
}

function take(map: Map<string, Bucket>, key: string, max: number, windowMs: number, now: number): { allowed: boolean; remaining: number; resetAt: number } {
  prune(map, now);
  let bucket = map.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    map.set(key, bucket);
  }
  bucket.count += 1;
  return { allowed: bucket.count <= max, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

function setHeaders(res: Response, max: number, remaining: number, resetAt: number, now: number): void {
  const resetSeconds = Math.ceil((resetAt - now) / 1000);
  res.setHeader("RateLimit-Limit", String(max));
  res.setHeader("RateLimit-Remaining", String(remaining));
  res.setHeader("RateLimit-Reset", String(resetSeconds));
  res.setHeader("X-RateLimit-Limit", String(max));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
}

function limited(res: Response, resetAt: number): void {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({
    error: { code: "RATE_LIMITED", message: "Rate limit exceeded. Retry after the interval in the Retry-After header." },
  });
}

/** Per-key (or per-IP) budget applied to every `/api/v1` request. */
export function generalLimiter(req: Request, res: Response, next: NextFunction): void {
  const max = generalRateLimit();
  const now = Date.now();
  const result = take(buckets, `g:${req.apiRateKey ?? `ip:${req.ip ?? "unknown"}`}`, max, WINDOW_MS, now);
  setHeaders(res, max, result.remaining, result.resetAt, now);
  if (!result.allowed) {
    limited(res, result.resetAt);
    return;
  }
  next();
}

const SENSITIVE_PREFIXES = [
  "POST /instances",
  "DELETE /instances",
  "PATCH /instances", // rename + resource changes
  "POST /nodes",
  "DELETE /nodes",
  "PATCH /nodes",
  "PATCH /settings",
  "POST /settings",
  "POST /users",
  "DELETE /users",
  "PATCH /users",
  "POST /api-keys",
  "PATCH /api-keys",
  "DELETE /api-keys",
  "POST /auth",
];

export function isSensitiveRoute(method: string, path: string): boolean {
  const key = `${method.toUpperCase()} ${path}`;
  return SENSITIVE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Stricter budget for credential, provisioning, deletion, and key endpoints. */
export function sensitiveLimiter(req: Request, res: Response, next: NextFunction): void {
  if (!isSensitiveRoute(req.method, req.path)) {
    next();
    return;
  }
  const max = sensitiveRateLimit();
  const now = Date.now();
  const result = take(buckets, `s:${req.apiRateKey ?? `ip:${req.ip ?? "unknown"}`}`, max, WINDOW_MS, now);
  setHeaders(res, max, result.remaining, result.resetAt, now);
  if (!result.allowed) {
    limited(res, result.resetAt);
    return;
  }
  next();
}

/* ------------------------- credential failures ------------------------- */

export function recordAuthFailure(ip: string | undefined): void {
  const now = Date.now();
  const key = `f:${ip ?? "unknown"}`;
  const bucket = authFailures.get(key);
  if (!bucket || bucket.resetAt <= now) {
    authFailures.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return;
  }
  bucket.count += 1;
  if (authFailures.size > memoryCeiling) prune(authFailures, now);
}

/** True when this client has failed authentication too often; sets 429 headers. */
export function authThrottle(req: Request, res: Response, next: NextFunction): void {
  const key = `f:${req.ip ?? "unknown"}`;
  const bucket = authFailures.get(key);
  const now = Date.now();
  if (bucket && bucket.resetAt > now && bucket.count >= authFailureLimit()) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many failed authentication attempts. Try again later." },
    });
    return;
  }
  next();
}

/** Test hook. */
export function resetLimits(): void {
  buckets.clear();
  authFailures.clear();
}
