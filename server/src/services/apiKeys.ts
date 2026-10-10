import crypto from "node:crypto";
import net from "node:net";
import type Database from "better-sqlite3";
import { newId, nowIso, sha256Hex } from "../db.js";
import { FULL_ACCESS, isKnownScope, isSubsetOf } from "../api/scopes.js";

/**
 * API key service.
 *
 * Secrets are generated with a CSPRNG (256 bits), returned to the caller
 * exactly once, and stored only as a SHA-256 hash next to a separate public
 * identifier used for lookup. Nothing in this module ever returns, logs, or
 * persists a plaintext secret after `createApiKey` hands it back.
 *
 * Token format:  kct_live_<12 hex public id>_<43 char base64url secret>
 * Display form:  kct_live_<12 hex public id>…   (the stored key_prefix)
 */

export const KEY_TOKEN_PATTERN = /^kct_live_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_by: string | null;
  created_by_key: string | null;
  scopes: string;
  ip_allowlist: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_endpoint: string | null;
  use_count: number;
  rotated_from: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

/** Safe metadata. Never contains key_hash or a secret. */
export interface PublicApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_by: string | null;
  created_by_name: string | null;
  created_by_key: string | null;
  scopes: string[];
  full_access: boolean;
  ip_allowlist: string[];
  expires_at: string | null;
  last_used_at: string | null;
  last_used_endpoint: string | null;
  use_count: number;
  rotated_from: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  status: "active" | "expired" | "revoked";
}

export type ApiKeyStatus = PublicApiKey["status"];

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function keyStatus(row: Pick<ApiKeyRow, "expires_at" | "revoked_at">): ApiKeyStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

export function toPublicApiKey(row: ApiKeyRow & { created_by_name?: string | null }): PublicApiKey {
  const scopes = parseJsonArray(row.scopes);
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    created_by_key: row.created_by_key ?? null,
    scopes,
    full_access: scopes.includes(FULL_ACCESS),
    ip_allowlist: parseJsonArray(row.ip_allowlist),
    expires_at: row.expires_at ?? null,
    last_used_at: row.last_used_at ?? null,
    last_used_endpoint: row.last_used_endpoint ?? null,
    use_count: Number(row.use_count ?? 0),
    rotated_from: row.rotated_from ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at ?? null,
    status: keyStatus(row),
  };
}

/* ------------------------------------------------------------------ *
 * IP restrictions
 * ------------------------------------------------------------------ */

interface ParsedEntry {
  exact: string | null;
  family: 4 | 6;
  bytes: Uint8Array;
  bits: number;
}

function ipv4Bytes(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function ipv6Bytes(ip: string): Uint8Array | null {
  let input = ip.trim();
  if (!input.includes(":")) return null;
  // Strip a zone id (fe80::1%eth0).
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  // IPv4-mapped tail: ::ffff:1.2.3.4
  const lastColon = input.lastIndexOf(":");
  const tail = input.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4Bytes(tail);
    if (!v4) return null;
    input = `${input.slice(0, lastColon + 1)}${[0, 1, 2, 3].map((i) => v4[i].toString(16)).join(":")}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rear = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - head.length - rear.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill("0"), ...rear];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function bytesFor(ip: string, family: 4 | 6): Uint8Array | null {
  return family === 4 ? ipv4Bytes(ip) : ipv6Bytes(ip);
}

/** Parse one entry: `203.0.113.7`, `203.0.113.0/24`, `2001:db8::1`, `2001:db8::/32`. */
export function parseIpEntry(raw: string): ParsedEntry | { error: string } {
  const entry = raw.trim();
  if (!entry) return { error: "Empty entry." };
  const [addrPart, maskPart, ...rest] = entry.split("/");
  if (rest.length > 0) return { error: `"${entry}" has more than one "/" separator.` };
  const isV4 = net.isIP(addrPart) === 4;
  const isV6 = net.isIP(addrPart) === 6;
  if (!isV4 && !isV6) return { error: `"${addrPart}" is not a valid IP address.` };
  const family: 4 | 6 = isV4 ? 4 : 6;
  const maxBits = family === 4 ? 32 : 128;
  let bits = maxBits;
  if (maskPart !== undefined) {
    if (!/^\d{1,3}$/.test(maskPart)) return { error: `"${maskPart}" is not a valid prefix length.` };
    bits = Number(maskPart);
    if (bits > maxBits) return { error: `Prefix length must be 0–${maxBits} for ${family === 4 ? "IPv4" : "IPv6"}.` };
  }
  const bytes = bytesFor(addrPart, family);
  if (!bytes) return { error: `"${addrPart}" is not a valid IP address.` };
  return { exact: maskPart === undefined ? addrPart.toLowerCase() : null, family, bytes, bits };
}

export function validateIpAllowlist(entries: readonly string[]): { ok: true; entries: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const cleaned: string[] = [];
  for (const entry of entries) {
    const parsed = parseIpEntry(entry);
    if ("error" in parsed) errors.push(parsed.error);
    else cleaned.push(entry.trim());
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries: [...new Set(cleaned)] };
}

function sameBytes(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  const fullBytes = bits >> 3;
  for (let i = 0; i < fullBytes; i++) if (a[i] !== b[i]) return false;
  const rem = bits & 7;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (a[fullBytes] & mask) === (b[fullBytes] & mask);
}

function normalizeClientIp(ip: string): string {
  const trimmed = ip.trim().replace(/^::ffff:/i, (m) => (net.isIP(m.slice(2)) === 4 ? "" : m));
  return trimmed.toLowerCase();
}

/** True when `ip` matches any configured entry. An empty list allows all. */
export function ipAllowed(ip: string | undefined | null, entries: readonly string[]): boolean {
  if (entries.length === 0) return true;
  if (!ip) return false;
  const client = normalizeClientIp(ip);
  const clientFamily = net.isIP(client);
  if (clientFamily !== 4 && clientFamily !== 6) return false;
  for (const entry of entries) {
    const parsed = parseIpEntry(entry);
    if ("error" in parsed) continue;
    if (parsed.exact && parsed.exact === client) return true;
    // IPv4 clients can only match IPv4 rules (and vice versa) after mapping.
    if (parsed.family !== clientFamily) continue;
    const bytes = bytesFor(client, parsed.family);
    if (bytes && sameBytes(bytes, parsed.bytes, parsed.bits)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Creation / verification
 * ------------------------------------------------------------------ */

export interface CreateApiKeyInput {
  name: string;
  scopes: string[];
  createdBy: string;
  createdByKey?: string | null;
  ipAllowlist?: string[];
  expiresAt?: string | null;
  rotatedFrom?: string | null;
}

export class ApiKeyValidationError extends Error {
  readonly details: { path: string; message: string }[];
  constructor(details: { path: string; message: string }[]) {
    super("Invalid API key request.");
    this.details = details;
  }
}

export function normalizeScopes(scopes: readonly string[]): string[] {
  const details: { path: string; message: string }[] = [];
  const unique = [...new Set(scopes)];
  for (const scope of unique) {
    if (!isKnownScope(scope)) details.push({ path: "scopes", message: `Unknown scope "${scope}".` });
  }
  if (unique.length === 0) details.push({ path: "scopes", message: "At least one scope is required." });
  if (details.length > 0) throw new ApiKeyValidationError(details);
  return unique;
}

export function normalizeExpiry(expiresAt: string | null | undefined): string | null {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return null;
  const ms = new Date(expiresAt).getTime();
  if (!Number.isFinite(ms)) throw new ApiKeyValidationError([{ path: "expires_at", message: "Expiration must be an ISO 8601 timestamp." }]);
  if (ms <= Date.now()) throw new ApiKeyValidationError([{ path: "expires_at", message: "Expiration must be in the future." }]);
  return new Date(ms).toISOString();
}

export function normalizeAllowlist(entries: readonly string[] | undefined): string[] {
  if (!entries || entries.length === 0) return [];
  if (entries.length > 64) {
    throw new ApiKeyValidationError([{ path: "ip_allowlist", message: "At most 64 IP entries are allowed." }]);
  }
  const result = validateIpAllowlist(entries);
  if (!result.ok) throw new ApiKeyValidationError(result.errors.map((message) => ({ path: "ip_allowlist", message })));
  return result.entries;
}

export interface CreatedApiKey {
  key: PublicApiKey;
  /** Plaintext secret. Returned once, never stored, never retrievable again. */
  secret: string;
}

export function createApiKey(db: Database.Database, input: CreateApiKeyInput): CreatedApiKey {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    throw new ApiKeyValidationError([{ path: "name", message: "Name must be 2–80 characters." }]);
  }
  const scopes = normalizeScopes(input.scopes);
  const expiresAt = normalizeExpiry(input.expiresAt);
  const allowlist = normalizeAllowlist(input.ipAllowlist);

  const publicId = crypto.randomBytes(6).toString("hex");
  const secret = crypto.randomBytes(32).toString("base64url"); // 256 bits
  const token = `kct_live_${publicId}_${secret}`;
  const keyPrefix = `kct_live_${publicId}`;
  const id = newId("key");
  const now = nowIso();

  db.prepare(
    `INSERT INTO api_keys (id, name, key_prefix, key_hash, created_by, created_by_key, scopes, ip_allowlist, expires_at, use_count, rotated_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    id,
    name,
    keyPrefix,
    sha256Hex(token),
    input.createdBy,
    input.createdByKey ?? null,
    JSON.stringify(scopes),
    allowlist.length > 0 ? JSON.stringify(allowlist) : null,
    expiresAt,
    input.rotatedFrom ?? null,
    now,
    now
  );
  const row = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow;
  // The full token is returned exactly once; only its hash is stored.
  return { key: toPublicApiKey(row), secret: token };
}

export type VerifyFailure =
  | "malformed"
  | "not_found"
  | "mismatch"
  | "expired"
  | "revoked"
  | "ip_not_allowed"
  | "owner_missing"
  | "owner_disabled";

export interface VerifiedKey {
  row: ApiKeyRow;
  scopes: string[];
}

/**
 * Constant-time-ish verification of a presented token.
 * Lookup is by public id; the hash comparison uses timingSafeEqual.
 */
export function verifyApiKey(db: Database.Database, token: string, clientIp: string | null): VerifiedKey | { failure: VerifyFailure } {
  const match = KEY_TOKEN_PATTERN.exec(token.trim());
  if (!match) return { failure: "malformed" };
  const [, publicId] = match;
  const keyPrefix = `kct_live_${publicId}`;
  const row = db.prepare("SELECT * FROM api_keys WHERE key_prefix = ?").get(keyPrefix) as ApiKeyRow | undefined;
  if (!row) return { failure: "not_found" };
  const presented = Buffer.from(sha256Hex(token), "hex");
  const stored = Buffer.from(row.key_hash, "hex");
  if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) {
    return { failure: "mismatch" };
  }
  if (row.revoked_at) return { failure: "revoked" };
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return { failure: "expired" };
  if (!ipAllowed(clientIp, parseJsonArray(row.ip_allowlist))) return { failure: "ip_not_allowed" };
  if (!row.created_by) return { failure: "owner_missing" };
  const owner = db.prepare("SELECT id, status FROM users WHERE id = ?").get(row.created_by) as
    | { id: string; status: string }
    | undefined;
  if (!owner) return { failure: "owner_missing" };
  if (owner.status !== "active") return { failure: "owner_disabled" };
  return { row, scopes: parseJsonArray(row.scopes) };
}

/* ------------------------------------------------------------------ *
 * Usage metadata
 * ------------------------------------------------------------------ */

const usageFlushAt = new Map<string, number>();
const USAGE_FLUSH_MS = 30_000;

/**
 * Refresh last-used metadata. Throttled per key so a busy client does not
 * turn every request into a write, while still staying accurate to ~30s.
 * The endpoint is stored as `METHOD /path` with no query string and no headers.
 */
export function recordKeyUsage(db: Database.Database, keyId: string, endpoint: string): void {
  const now = Date.now();
  const last = usageFlushAt.get(keyId) ?? 0;
  if (now - last < USAGE_FLUSH_MS) return;
  usageFlushAt.set(keyId, now);
  try {
    db.prepare(
      "UPDATE api_keys SET last_used_at = ?, last_used_endpoint = ?, use_count = use_count + 1 WHERE id = ?"
    ).run(nowIso(), endpoint, keyId);
  } catch {
    // Usage accounting must never break a request.
  }
}

/** Test hook: forget throttling state between cases. */
export function resetUsageThrottle(): void {
  usageFlushAt.clear();
}

/* ------------------------------------------------------------------ *
 * Queries and lifecycle
 * ------------------------------------------------------------------ */

export interface ListVisibility {
  /** Session administrators see every key; an API key sees only its own children. */
  mode: "all" | "children";
  /** Required for `children`: the calling key id. */
  keyId?: string;
  /** Optional owner filter for session administrators. */
  createdBy?: string;
}

export interface ListOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: ApiKeyStatus | "all";
  visibility: ListVisibility;
}

export interface ListResult {
  keys: PublicApiKey[];
  pagination: { page: number; page_size: number; total: number };
}

export function listApiKeys(db: Database.Database, opts: ListOptions): ListResult {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
  const offset = (page - 1) * pageSize;
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.visibility.mode === "children") {
    where.push("k.created_by_key = ?");
    params.push(opts.visibility.keyId ?? "");
  } else if (opts.visibility.createdBy) {
    where.push("k.created_by = ?");
    params.push(opts.visibility.createdBy);
  }
  const search = (opts.search ?? "").trim().toLowerCase();
  if (search) {
    where.push("(lower(k.name) LIKE ? OR lower(k.key_prefix) LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (opts.status && opts.status !== "all") {
    if (opts.status === "revoked") where.push("k.revoked_at IS NOT NULL");
    else if (opts.status === "active") where.push("k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)");
    else where.push("k.revoked_at IS NULL AND k.expires_at IS NOT NULL AND k.expires_at <= ?");
    if (opts.status === "active" || opts.status === "expired") params.push(nowIso());
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM api_keys k ${clause}`).get(...(params as never[])) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT k.*, u.name AS created_by_name FROM api_keys k
       LEFT JOIN users u ON u.id = k.created_by
       ${clause} ORDER BY k.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...(params as never[]), pageSize, offset) as (ApiKeyRow & { created_by_name: string | null })[];
  return { keys: rows.map(toPublicApiKey), pagination: { page, page_size: pageSize, total } };
}

export function getApiKeyRow(db: Database.Database, id: string): ApiKeyRow | undefined {
  return db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | undefined;
}

/**
 * Visibility for single-key operations: administrators manage every key,
 * an API key manages only keys it created.
 */
export function canManageKey(row: ApiKeyRow, visibility: ListVisibility, callerKeyId?: string): boolean {
  if (visibility.mode === "all") return true;
  return row.created_by_key !== null && row.created_by_key === callerKeyId;
}

export function getPublicApiKey(db: Database.Database, id: string): PublicApiKey | null {
  const row = db
    .prepare("SELECT k.*, u.name AS created_by_name FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.id = ?")
    .get(id) as (ApiKeyRow & { created_by_name: string | null }) | undefined;
  return row ? toPublicApiKey(row) : null;
}

export interface UpdateApiKeyInput {
  name?: string;
  scopes?: string[];
  expiresAt?: string | null | undefined;
  ipAllowlist?: string[];
}

/** Metadata-only update. The secret is untouched — editing never rotates it. */
export function updateApiKey(db: Database.Database, id: string, input: UpdateApiKeyInput): PublicApiKey {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 80) {
      throw new ApiKeyValidationError([{ path: "name", message: "Name must be 2–80 characters." }]);
    }
    sets.push("name = ?");
    params.push(name);
  }
  if (input.scopes !== undefined) {
    sets.push("scopes = ?");
    params.push(JSON.stringify(normalizeScopes(input.scopes)));
  }
  if (input.expiresAt !== undefined) {
    sets.push("expires_at = ?");
    params.push(normalizeExpiry(input.expiresAt));
  }
  if (input.ipAllowlist !== undefined) {
    const list = normalizeAllowlist(input.ipAllowlist);
    sets.push("ip_allowlist = ?");
    params.push(list.length > 0 ? JSON.stringify(list) : null);
  }
  if (sets.length === 0) throw new ApiKeyValidationError([{ path: "body", message: "No changes provided." }]);
  sets.push("updated_at = ?");
  params.push(nowIso(), id);
  db.prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`).run(...(params as never[]));
  return getPublicApiKey(db, id)!;
}

/**
 * Immediate revocation. Checked on every request, so no restart is needed.
 * Subordinate keys (created by this key) are revoked too: revocation is
 * never defeated by presenting a descendant credential.
 */
export function revokeApiKey(db: Database.Database, id: string): PublicApiKey {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    db.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), current);
    const children = db.prepare("SELECT id FROM api_keys WHERE created_by_key = ?").all(current) as { id: string }[];
    for (const child of children) queue.push(child.id);
  }
  return getPublicApiKey(db, id)!;
}

export interface RotateOptions {
  /** Revoke the old key in the same call, after the replacement exists. */
  revokeOld?: boolean;
  /** Who is performing the rotation (audit actor). */
  actorId: string;
  /** Set when the rotation is performed by an API key (records lineage). */
  callerKeyId?: string | null;
}

/**
 * Rotation creates a verified replacement first (same metadata, fresh secret),
 * then optionally revokes the original — so continuity is possible by leaving
 * the old key alive until the new secret has been tested.
 */
export function rotateApiKey(db: Database.Database, id: string, opts: RotateOptions): CreatedApiKey {
  const old = getApiKeyRow(db, id);
  if (!old) throw new ApiKeyValidationError([{ path: "id", message: "Key not found." }]);
  const created = createApiKey(db, {
    name: old.name,
    scopes: parseJsonArray(old.scopes),
    createdBy: old.created_by ?? opts.actorId,
    createdByKey: opts.callerKeyId ?? old.created_by_key ?? null,
    ipAllowlist: parseJsonArray(old.ip_allowlist),
    expiresAt: old.expires_at,
    rotatedFrom: old.id,
  });
  if (opts.revokeOld) revokeApiKey(db, old.id);
  return created;
}
