import { Router } from "express";
import { z } from "zod";
import { getDb, getSetting, nowIso } from "../db.js";
import { hashPassword, verifyPassword } from "../services/password.js";
import { recordAudit } from "../services/audit.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get("/", (req, res) => {
  res.json({ data: { user: req.user } });
});

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().email().max(254).optional(),
  avatar_seed: z.string().trim().min(1).max(120).optional(),
});

meRouter.patch("/", validate(profileSchema), (req, res) => {
  const db = getDb();
  const user = req.user!;
  const updates: string[] = [];
  const params: unknown[] = [];
  if (req.body.name !== undefined) {
    updates.push("name = ?");
    params.push(String(req.body.name).trim());
  }
  if (req.body.email !== undefined) {
    const email = String(req.body.email).trim().toLowerCase();
    const clash = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, user.id) as unknown;
    if (clash) {
      res.status(409).json({ error: { code: "EMAIL_TAKEN", message: "This email is already in use." } });
      return;
    }
    updates.push("email = ?");
    params.push(email);
  }
  if (req.body.avatar_seed !== undefined) {
    updates.push("avatar_seed = ?");
    params.push(String(req.body.avatar_seed).trim().slice(0, 120));
  }
  if (updates.length === 0) {
    res.status(400).json({ error: { code: "NO_CHANGES", message: "No changes provided." } });
    return;
  }
  updates.push("updated_at = ?");
  params.push(nowIso());
  params.push(user.id);
  db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...(params as never[]));
  recordAudit(db, { actorId: user.id, action: "profile.update", targetType: "user", targetId: user.id });
  const fresh = db
    .prepare("SELECT id, email, name, role, status, avatar_seed, created_at FROM users WHERE id = ?")
    .get(user.id);
  res.json({ data: { user: fresh } });
});

const passwordSchema = z.object({
  current_password: z.string().min(1).max(256),
  new_password: z.string().min(1).max(256),
});

meRouter.post("/password", validate(passwordSchema), async (req, res) => {
  const db = getDb();
  const user = req.user!;
  const dbUser = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as {
    password_hash: string;
  };
  const ok = await verifyPassword(dbUser.password_hash, String(req.body.current_password));
  if (!ok) {
    res.status(401).json({ error: { code: "INVALID_PASSWORD", message: "Current password is incorrect." } });
    return;
  }
  const minLen = Number(getSetting(db, "password_min_length") ?? 10) || 10;
  if (String(req.body.new_password).length < minLen) {
    res.status(400).json({ error: { code: "WEAK_PASSWORD", message: `Password must be at least ${minLen} characters.` } });
    return;
  }
  const hash = await hashPassword(String(req.body.new_password));
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, nowIso(), user.id);
  // Invalidate all other sessions for this user.
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(user.id, req.sessionId ?? "");
  recordAudit(db, { actorId: user.id, action: "profile.password_change", targetType: "user", targetId: user.id });
  res.json({ data: { ok: true } });
});
