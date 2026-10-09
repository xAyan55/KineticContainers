import type { NextFunction, Request, Response } from "express";
import { getDb, sha256Hex } from "../db.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  avatar_seed: string;
  created_at: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

export function cookieName(): string {
  return process.env.SESSION_COOKIE_NAME?.trim() || "kct_session";
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[cookieName()];
    if (!token || typeof token !== "string") {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
      return;
    }
    const db = getDb();
    const session = db
      .prepare("SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?")
      .get(sha256Hex(token)) as { id: string; user_id: string; expires_at: string } | undefined;
    if (!session) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
      return;
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
      res.status(401).json({ error: { code: "SESSION_EXPIRED", message: "Session expired." } });
      return;
    }
    const user = db
      .prepare("SELECT id, email, name, role, status, avatar_seed, created_at FROM users WHERE id = ?")
      .get(session.user_id) as AuthUser | undefined;
    if (!user || user.status !== "active") {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
      return;
    }
    req.user = user;
    req.sessionId = session.id;
    next();
  } catch {
    res.status(500).json({ error: { code: "INTERNAL", message: "Authentication check failed." } });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Administrator access required." } });
    return;
  }
  next();
}

/** Basic same-origin/CSRF check for cookie-authenticated mutations. */
export function csrfCheck(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = req.headers.host;
  if (!origin && !referer) {
    next(); // non-browser clients (curl, tests)
    return;
  }
  const allowed = (origin ?? referer ?? "").toLowerCase();
  // Require the request to originate from the same host or an explicitly allowed CORS origin.
  const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sameHost = host ? allowed.includes(host.toLowerCase()) : false;
  const corsAllowed = corsOrigins.some((o) => o && allowed.startsWith(o));
  if (sameHost || corsAllowed) {
    next();
    return;
  }
  res.status(403).json({ error: { code: "CSRF", message: "Origin check failed." } });
}
