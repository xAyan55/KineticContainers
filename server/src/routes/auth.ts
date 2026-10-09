import { Router } from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { z } from "zod";
import { getDb, getSetting, newId, nowIso, sha256Hex } from "../db.js";
import { hashPassword, verifyPassword } from "../services/password.js";
import { recordAudit, toPublicUser } from "../services/audit.js";
import { cookieName, requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 20),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later." } },
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(256),
  name: z.string().trim().min(1).max(120),
});

function sessionTtlMs(): number {
  const db = getDb();
  const raw = getSetting(db, "session_ttl_hours") ?? "168";
  const hours = Math.min(Math.max(Number(raw) || 168, 1), 720);
  return hours * 3600 * 1000;
}

function setSessionCookie(res: Parameters<Parameters<typeof authRouter.post>[1]>[1], token: string): void {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(cookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    path: "/",
    maxAge: sessionTtlMs(),
  });
}

authRouter.post("/login", loginLimiter, validate(loginSchema), async (req, res) => {
  const db = getDb();
  const email = String(req.body.email).trim().toLowerCase();
  // Generic error: never reveal whether the email exists.
  const generic = { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } };
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
  if (!user) {
    // Constant-time-ish dummy check to avoid trivial user enumeration via timing.
    await verifyPassword(await hashPassword(crypto.randomBytes(8).toString("hex")), "dummy");
    res.status(401).json(generic);
    return;
  }
  if (user.status !== "active") {
    res.status(401).json(generic);
    return;
  }
  const ok = await verifyPassword(user.password_hash, String(req.body.password));
  if (!ok) {
    recordAudit(db, { action: "auth.login_failed", targetType: "user", targetId: user.id });
    res.status(401).json(generic);
    return;
  }
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + sessionTtlMs()).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?)").run(
    newId("sess"),
    user.id,
    sha256Hex(token),
    nowIso(),
    expires,
    req.ip ?? null
  );
  recordAudit(db, { actorId: user.id, action: "auth.login", targetType: "user", targetId: user.id });
  setSessionCookie(res as never, token);
  res.json({ data: { user: toPublicUser(user) } });
});

authRouter.post("/logout", requireAuth, (req, res) => {
  const db = getDb();
  if (req.sessionId) db.prepare("DELETE FROM sessions WHERE id = ?").run(req.sessionId);
  res.clearCookie(cookieName(), { path: "/" });
  res.json({ data: { ok: true } });
});

authRouter.get("/session", requireAuth, (req, res) => {
  res.json({ data: { user: req.user } });
});

authRouter.post("/register", validate(registerSchema), async (req, res) => {
  const db = getDb();
  const enabled = (getSetting(db, "registration_enabled") ?? "false") === "true";
  if (!enabled) {
    res.status(403).json({ error: { code: "REGISTRATION_DISABLED", message: "Public registration is disabled." } });
    return;
  }
  const minLen = Number(getSetting(db, "password_min_length") ?? 10) || 10;
  if (String(req.body.password).length < minLen) {
    res.status(400).json({ error: { code: "WEAK_PASSWORD", message: `Password must be at least ${minLen} characters.` } });
    return;
  }
  const email = String(req.body.email).trim().toLowerCase();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
  if (existing) {
    // Do not leak enumeration: report conflict generically but with 409 so UI can hint.
    res.status(409).json({ error: { code: "EMAIL_TAKEN", message: "An account with this email already exists." } });
    return;
  }
  const id = newId("usr");
  const now = nowIso();
  const passwordHash = await hashPassword(String(req.body.password));
  const isFirstUser = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"
  ).run(id, email, String(req.body.name).trim().slice(0, 120), passwordHash, isFirstUser ? "admin" : "user", email, now, now);
  recordAudit(db, { actorId: id, action: "auth.register", targetType: "user", targetId: id });
  const user = db.prepare("SELECT id, email, name, role, status, avatar_seed, created_at FROM users WHERE id = ?").get(id);
  res.status(201).json({ data: { user } });
});
