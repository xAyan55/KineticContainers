import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { ProviderError } from "./virtualization/provider.js";
import { resolveDatabasePath } from "../db.js";

export type BrandingKind = "logo" | "favicon";

/**
 * Admin-uploaded brand images. Stored as files (never in the DB, never with
 * user-supplied filenames), served publicly so the login page can use them.
 * Only raster formats are accepted — SVG is rejected outright because an
 * attacker-controlled SVG served same-origin is a stored-XSS vector.
 */
const ALLOWED: Record<string, { exts: string[]; maxBytes: number; magic: (b: Buffer) => boolean }> = {
  logo: {
    exts: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    maxBytes: 1024 * 1024,
    magic: (b) => isPng(b) || isJpeg(b) || isWebp(b) || isGif(b),
  },
  favicon: {
    exts: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon"],
    maxBytes: 256 * 1024,
    magic: (b) => isPng(b) || isJpeg(b) || isWebp(b) || isGif(b) || isIco(b),
  },
};

function isPng(b: Buffer): boolean {
  return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function isJpeg(b: Buffer): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isGif(b: Buffer): boolean {
  return b.length >= 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a");
}

function isWebp(b: Buffer): boolean {
  return (
    b.length >= 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  );
}

function isIco(b: Buffer): boolean {
  return b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00;
}

export function brandingDir(): string {
  if (process.env.KINETICCT_BRANDING_DIR?.trim()) {
    const dir = path.resolve(process.env.KINETICCT_BRANDING_DIR.trim());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(path.dirname(resolveDatabasePath()), "branding");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(kind: BrandingKind): string {
  return path.join(brandingDir(), kind);
}

function parseDataUrl(value: unknown): { mime: string; bytes: Buffer } {
  if (typeof value !== "string") {
    throw new ProviderError("VALIDATION", "Image must be a data URL string.", 400);
  }
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (!m) {
    throw new ProviderError("VALIDATION", "Image must be a base64 data URL (data:<mime>;base64,...).", 400);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(m[2], "base64");
  } catch {
    throw new ProviderError("VALIDATION", "Image body is not valid base64.", 400);
  }
  if (bytes.length === 0) {
    throw new ProviderError("VALIDATION", "Image is empty.", 400);
  }
  return { mime: m[1].toLowerCase(), bytes };
}

/** Validate and persist an uploaded brand image. Returns the stored mime type. */
export function saveBrandingImage(db: Database.Database, kind: BrandingKind, dataUrl: string): string {
  const rule = ALLOWED[kind];
  const { mime, bytes } = parseDataUrl(dataUrl);
  if (!rule.exts.includes(mime)) {
    throw new ProviderError(
      "VALIDATION",
      `Unsupported image type '${mime}'. Allowed: ${rule.exts.join(", ")}. SVG is rejected for security.`,
      400
    );
  }
  if (bytes.length > rule.maxBytes) {
    throw new ProviderError(
      "VALIDATION",
      `Image is too large (${bytes.length} bytes, max ${rule.maxBytes}).`,
      400
    );
  }
  if (!rule.magic(bytes)) {
    throw new ProviderError("VALIDATION", "File contents do not match the claimed image type.", 400);
  }
  fs.writeFileSync(fileFor(kind), bytes);
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(kind === "logo" ? "logo_mime" : "favicon_mime", mime, new Date().toISOString());
  return mime;
}

/** Remove a brand image. Missing files are not an error (idempotent). */
export function clearBrandingImage(db: Database.Database, kind: BrandingKind): void {
  try {
    fs.rmSync(fileFor(kind), { force: true });
  } catch {
    /* best effort; a missing file is fine */
  }
  db.prepare("DELETE FROM settings WHERE key = ?").run(kind === "logo" ? "logo_mime" : "favicon_mime");
}

export function brandingMime(db: Database.Database, kind: BrandingKind): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(kind === "logo" ? "logo_mime" : "favicon_mime") as { value: string } | undefined;
  if (!row || !ALLOWED[kind].exts.includes(row.value)) return null;
  if (!fs.existsSync(fileFor(kind))) return null;
  return row.value;
}

/** Public URL for a brand image, with mtime cache-busting; "" when absent. */
export function brandingUrl(db: Database.Database, kind: BrandingKind): string {
  const mime = brandingMime(db, kind);
  if (!mime) return "";
  let v = 0;
  try {
    v = Math.floor(fs.statSync(fileFor(kind)).mtimeMs);
  } catch {
    return "";
  }
  return `/api/settings/branding/${kind}?v=${v}`;
}

/** Read a stored brand image for serving. Null when absent or inconsistent. */
export function readBrandingFile(db: Database.Database, kind: BrandingKind): { bytes: Buffer; mime: string } | null {
  const mime = brandingMime(db, kind);
  if (!mime) return null;
  try {
    return { bytes: fs.readFileSync(fileFor(kind)), mime };
  } catch {
    return null;
  }
}
