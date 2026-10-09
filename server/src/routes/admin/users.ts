import { Router } from "express";
import { z } from "zod";
import { getDb, nowIso } from "../../db.js";
import { hashPassword } from "../../services/password.js";
import { recordAudit, toPublicUser } from "../../services/audit.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

export const adminUsersRouter = Router();
adminUsersRouter.use(requireAuth, requireAdmin);

adminUsersRouter.get("/", (req, res) => {
  const db = getDb();
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size ?? 25) || 25));
  const offset = (page - 1) * pageSize;
  let where = "";
  const params: unknown[] = [];
  if (q) {
    where = "WHERE lower(u.email) LIKE ? OR lower(u.name) LIKE ?";
    params.push(`%${q}%`, `%${q}%`);
  }
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).get(...(params as never[])) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM instances i WHERE i.owner_id = u.id) AS instance_count
       FROM users u ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...(params as never[]), pageSize, offset) as Record<string, unknown>[];
  res.json({
    data: {
      users: rows.map((r) => ({ ...toPublicUser(r), instance_count: (r as { instance_count: number }).instance_count })),
      pagination: { page, page_size: pageSize, total },
    },
  });
});

adminUsersRouter.get("/:id", (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!user) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }
  const instances = db.prepare("SELECT * FROM instances WHERE owner_id = ? ORDER BY created_at DESC").all(user.id as string);
  res.json({ data: { user: toPublicUser(user), instances } });
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().email().max(254).optional(),
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

adminUsersRouter.patch("/:id", validate(updateSchema), (req, res) => {
  const db = getDb();
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!target) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }
  // Prevent accidental self-lockout: admin cannot demote/disable themselves.
  if (target.id === req.user!.id) {
    if (req.body.role && req.body.role !== "admin") {
      res.status(400).json({ error: { code: "SELF_LOCKOUT", message: "You cannot remove your own administrator role." } });
      return;
    }
    if (req.body.status === "disabled") {
      res.status(400).json({ error: { code: "SELF_LOCKOUT", message: "You cannot disable your own account." } });
      return;
    }
  }
  if (req.body.email) {
    const clash = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(
      String(req.body.email).trim().toLowerCase(),
      target.id as string
    ) as unknown;
    if (clash) {
      res.status(409).json({ error: { code: "EMAIL_TAKEN", message: "This email is already in use." } });
      return;
    }
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of ["name", "email", "role", "status"] as const) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(key === "email" ? String(req.body[key]).trim().toLowerCase() : req.body[key]);
    }
  }
  if (sets.length === 0) {
    res.status(400).json({ error: { code: "NO_CHANGES", message: "No changes provided." } });
    return;
  }
  sets.push("updated_at = ?");
  params.push(nowIso(), target.id as string);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...(params as never[]));
  recordAudit(db, { actorId: req.user!.id, action: "admin.user_update", targetType: "user", targetId: target.id as string, detail: req.body });
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(target.id as string) as Record<string, unknown>;
  res.json({ data: { user: toPublicUser(fresh) } });
});

const resetSchema = z.object({ new_password: z.string().min(10).max(256) });

adminUsersRouter.post("/:id/reset-password", validate(resetSchema), async (req, res) => {
  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id) as { id: string } | undefined;
  if (!target) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }
  const hash = await hashPassword(String(req.body.new_password));
  const txn = db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, nowIso(), target.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
  });
  txn();
  recordAudit(db, { actorId: req.user!.id, action: "admin.password_reset", targetType: "user", targetId: target.id });
  res.json({ data: { ok: true } });
});

// Ownership policy: disabling/revoking keeps instances; explicit transfer or delete required.
const transferSchema = z.object({ target_user_id: z.string().min(1).max(128) });

adminUsersRouter.post("/:id/transfer-instances", validate(transferSchema), (req, res) => {
  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(req.body.target_user_id) as { id: string } | undefined;
  if (!target) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Target user not found." } });
    return;
  }
  const result = db.prepare("UPDATE instances SET owner_id = ?, updated_at = ? WHERE owner_id = ?").run(target.id, nowIso(), req.params.id);
  recordAudit(db, { actorId: req.user!.id, action: "admin.instances_transfer", targetType: "user", targetId: req.params.id, detail: { to: target.id, count: result.changes } });
  res.json({ data: { transferred: result.changes } });
});

adminUsersRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id) as { id: string } | undefined;
  if (!target) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }
  if (target.id === req.user!.id) {
    res.status(400).json({ error: { code: "SELF_LOCKOUT", message: "You cannot delete your own account." } });
    return;
  }
  const owned = (db.prepare("SELECT COUNT(*) AS n FROM instances WHERE owner_id = ?").get(target.id) as { n: number }).n;
  if (owned > 0) {
    res.status(409).json({
      error: {
        code: "HAS_INSTANCES",
        message: `This account still owns ${owned} instance(s). Transfer or remove them first; accounts are never deleted with instances attached.`,
      },
    });
    return;
  }
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
  });
  txn();
  recordAudit(db, { actorId: req.user!.id, action: "admin.user_delete", targetType: "user", targetId: target.id });
  res.json({ data: { ok: true } });
});

const assignSchema = z.object({ instance_id: z.string().min(1).max(128) });

adminUsersRouter.post("/:id/assign-instance", validate(assignSchema), (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id) as { id: string } | undefined;
  if (!user) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }
  const inst = db.prepare("SELECT id FROM instances WHERE id = ?").get(req.body.instance_id) as { id: string } | undefined;
  if (!inst) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Instance not found." } });
    return;
  }
  db.prepare("UPDATE instances SET owner_id = ?, updated_at = ? WHERE id = ?").run(user.id, nowIso(), inst.id);
  recordAudit(db, { actorId: req.user!.id, action: "admin.instance_assign", targetType: "instance", targetId: inst.id, detail: { owner: user.id } });
  res.json({ data: { ok: true } });
});
