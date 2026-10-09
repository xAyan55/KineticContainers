import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type Role = "admin" | "user";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  status: "active" | "disabled";
  avatar_seed: string;
  created_at: string;
  updated_at: string;
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      avatar_seed TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      api_token TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at TEXT,
      capabilities TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      container_id TEXT NOT NULL UNIQUE,
      node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'unknown',
      cpu INTEGER NOT NULL DEFAULT 1,
      memory_mb INTEGER NOT NULL DEFAULT 512,
      storage_gb INTEGER NOT NULL DEFAULT 10,
      template TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_instances_owner ON instances(owner_id);
    CREATE INDEX IF NOT EXISTS idx_instances_node ON instances(node_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
    `,
  },
];

const DEFAULT_SETTINGS: Record<string, string> = {
  app_name: "KineticCT",
  app_description: "Self-hosted LXC container management panel.",
  page_title: "KineticCT",
  registration_enabled: "false",
  session_ttl_hours: "168",
  password_min_length: "10",
  timezone: "UTC",
};

export function resolveDatabasePath(): string {
  const fromEnv = process.env.DATABASE_PATH?.trim();
  if (fromEnv) return path.resolve(process.cwd(), fromEnv);
  return path.resolve(process.cwd(), "data", "kineticct.sqlite");
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = resolveDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  dbInstance = new Database(dbPath);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  migrate(dbInstance);
  seedDefaults(dbInstance);
  return dbInstance;
}

/** For tests: open an isolated in-memory database. */
export function openTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seedDefaults(db);
  return db;
}

export function setDbForTests(db: Database.Database): void {
  dbInstance = db;
}

export function migrate(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`
  );
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version as number)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const txn = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        m.version,
        new Date().toISOString()
      );
    });
    txn();
  }
}

function seedDefaults(db: Database.Database): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)"
  );
  const txn = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v, now);
  });
  txn();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix = ""): string {
  const raw = crypto.randomBytes(12).toString("hex");
  return prefix ? `${prefix}_${raw}` : raw;
}

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value, nowIso());
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
