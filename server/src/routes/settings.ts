import { Router } from "express";
import { z } from "zod";
import { getDb, getSetting, setSetting } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";

export const settingsRouter = Router();

const PUBLIC_KEYS = [
  "app_name",
  "app_description",
  "page_title",
  "registration_enabled",
  "timezone",
  "password_min_length",
] as const;

settingsRouter.get("/public", (_req, res) => {
  const db = getDb();
  const out: Record<string, string> = {};
  for (const k of PUBLIC_KEYS) out[k] = getSetting(db, k) ?? "";
  res.json({ data: { settings: out } });
});

const MANAGED_KEYS = [
  "app_name",
  "app_description",
  "page_title",
  "registration_enabled",
  "session_ttl_hours",
  "password_min_length",
  "timezone",
] as const;

settingsRouter.get("/", requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();
  const out: Record<string, string> = {};
  for (const k of MANAGED_KEYS) out[k] = getSetting(db, k) ?? "";
  const migration = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  res.json({
    data: {
      settings: out,
      meta: {
        migration_version: migration.v ?? 0,
        app_version: process.env.npm_package_version ?? "0.1.0",
        node_version: process.version,
      },
    },
  });
});

const updateSchema = z.object({
  app_name: z.string().trim().min(1).max(80).optional(),
  app_description: z.string().trim().max(500).optional(),
  page_title: z.string().trim().min(1).max(80).optional(),
  registration_enabled: z.union([z.boolean(), z.string()]).optional(),
  session_ttl_hours: z.coerce.number().int().min(1).max(720).optional(),
  password_min_length: z.coerce.number().int().min(8).max(64).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
});

settingsRouter.patch("/", requireAuth, requireAdmin, validate(updateSchema), (req, res) => {
  const db = getDb();
  const body = req.body as Record<string, unknown>;
  if (body.app_name !== undefined) setSetting(db, "app_name", String(body.app_name).trim());
  if (body.app_description !== undefined) setSetting(db, "app_description", String(body.app_description).trim());
  if (body.page_title !== undefined) setSetting(db, "page_title", String(body.page_title).trim());
  if (body.registration_enabled !== undefined) {
    const v = body.registration_enabled === true || body.registration_enabled === "true" ? "true" : "false";
    setSetting(db, "registration_enabled", v);
  }
  if (body.session_ttl_hours !== undefined) setSetting(db, "session_ttl_hours", String(body.session_ttl_hours));
  if (body.password_min_length !== undefined) setSetting(db, "password_min_length", String(body.password_min_length));
  if (body.timezone !== undefined) setSetting(db, "timezone", String(body.timezone).trim());
  recordAudit(db, { actorId: req.user!.id, action: "settings.update", detail: body });
  const out: Record<string, string> = {};
  for (const k of MANAGED_KEYS) out[k] = getSetting(db, k) ?? "";
  res.json({ data: { settings: out } });
});
