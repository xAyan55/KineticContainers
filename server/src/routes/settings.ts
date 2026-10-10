import { Router } from "express";
import express from "express";
import { z } from "zod";
import { getDb, getSetting, setSetting } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  brandingUrl,
  clearBrandingImage,
  readBrandingFile,
  saveBrandingImage,
  type BrandingKind,
} from "../services/branding.js";
import { ProviderError } from "../services/virtualization/provider.js";

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
  out.logo_url = brandingUrl(db, "logo");
  out.favicon_url = brandingUrl(db, "favicon");
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
  out.logo_url = brandingUrl(db, "logo");
  out.favicon_url = brandingUrl(db, "favicon");
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

// Brand images are base64 data URLs in JSON (no multipart dependency).
// String-length gate first (1MB decodes to ~1.37M chars); exact byte caps
// are enforced after decoding in saveBrandingImage.
const brandingSchema = z.object({
  logo: z.string().max(2_000_000).nullable().optional(),
  favicon: z.string().max(500_000).nullable().optional(),
});

settingsRouter.post(
  "/branding",
  requireAuth,
  requireAdmin,
  express.json({ limit: "2mb" }),
  validate(brandingSchema),
  (req, res) => {
    const db = getDb();
    const body = req.body as { logo?: string | null; favicon?: string | null };
    const changed: string[] = [];
    try {
      for (const kind of ["logo", "favicon"] as const) {
        const value = body[kind];
        if (value === undefined) continue;
        if (value === null || value === "") {
          clearBrandingImage(db, kind);
          changed.push(`${kind}:cleared`);
        } else {
          saveBrandingImage(db, kind, value);
          changed.push(`${kind}:updated`);
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      res.status(400).json({ error: { code: "VALIDATION", message: "Invalid image upload." } });
      return;
    }
    recordAudit(db, { actorId: req.user!.id, action: "settings.branding_update", detail: { changed } });
    res.json({
      data: { logo_url: brandingUrl(db, "logo"), favicon_url: brandingUrl(db, "favicon") },
    });
  }
);

const assetSchema = z.object({ kind: z.enum(["logo", "favicon"]) });

/** Publicly served so the login page can display them. No secrets here. */
settingsRouter.get("/branding/:kind", (req, res) => {
  const parsed = assetSchema.safeParse({ kind: req.params.kind });
  if (!parsed.success) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } });
    return;
  }
  const kind = parsed.data.kind as BrandingKind;
  const file = readBrandingFile(getDb(), kind);
  if (!file) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "No image configured." } });
    return;
  }
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Content-Length", String(file.bytes.length));
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(file.bytes);
});
