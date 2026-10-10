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

type Migration = { version: number; sql: string } | { version: number; run: (db: Database.Database) => void };

const MIGRATIONS: Migration[] = [
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
  {
    // Node management: richer node records + automatic Local Node.
    // Implemented as code (not pure SQL) so upgrades stay safe on
    // databases with unexpected pre-existing state: columns are added
    // only when missing, duplicate local rows are merged (instances are
    // repointed, never deleted), and seeding never touches existing rows.
    version: 2,
    run: (db: Database.Database) => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[]).map((r) => r.name)
      );
      const addColumn = (ddl: string, name: string): void => {
        if (!cols.has(name)) db.exec(`ALTER TABLE nodes ADD COLUMN ${ddl}`);
      };
      addColumn("node_type TEXT NOT NULL DEFAULT 'remote'", "node_type");
      addColumn("provider TEXT NOT NULL DEFAULT 'local-lxc'", "provider");
      addColumn("host_address TEXT", "host_address");
      addColumn("last_check_at TEXT", "last_check_at");
      addColumn("last_check_ok INTEGER", "last_check_ok");
      addColumn("last_error TEXT", "last_error");
      addColumn("is_protected INTEGER NOT NULL DEFAULT 0", "is_protected");

      // Merge duplicate local-endpoint rows (possible on DBs predating the
      // uniqueness guard): keep the earliest, repoint its instances, drop
      // the rest. Instances are preserved; only redundant node rows go.
      const locals = db
        .prepare("SELECT id FROM nodes WHERE endpoint = 'local' ORDER BY created_at ASC, id ASC")
        .all() as { id: string }[];
      if (locals.length > 1) {
        const keep = locals[0].id;
        const merge = db.transaction(() => {
          db.prepare(
            "UPDATE instances SET node_id = ? WHERE node_id IN (SELECT id FROM nodes WHERE endpoint = 'local' AND id != ?)"
          ).run(keep, keep);
          db.prepare("DELETE FROM nodes WHERE endpoint = 'local' AND id != ?").run(keep);
        });
        merge();
      }

      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_local_single ON nodes(endpoint) WHERE endpoint = 'local'");
      ensureLocalNode(db);
    },
  },
  {
    // API keys (Bearer auth for /api/v1) + the operation/job log that makes
    // long-running infrastructure work inspectable and restart-safe.
    // Pure SQL, additive only: existing rows and settings are untouched.
    version: 3,
    sql: `
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL UNIQUE,
      key_hash TEXT NOT NULL UNIQUE,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_by_key TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      ip_allowlist TEXT,
      expires_at TEXT,
      last_used_at TEXT,
      last_used_endpoint TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      rotated_from TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON api_keys(created_by);
    CREATE INDEX IF NOT EXISTS idx_api_keys_created_by_key ON api_keys(created_by_key);
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
      instance_id TEXT,
      node_id TEXT,
      actor_id TEXT,
      actor_key_id TEXT,
      detail TEXT,
      error TEXT,
      progress TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operations_created ON operations(created_at);
    CREATE INDEX IF NOT EXISTS idx_operations_instance ON operations(instance_id);
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
      if ("sql" in m) {
        db.exec(m.sql);
      } else {
        m.run(db);
      }
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
  ensureLocalNode(db);
}

/**
 * Idempotent boot-time guarantee: the host running the KineticCT backend is
 * always registered as the `local` node. Never touches an existing row, so
 * custom names, other nodes, containers, and settings are preserved, and
 * restarts can never create duplicates (fixed id + WHERE NOT EXISTS +
 * partial unique index as backstops).
 */
export function ensureLocalNode(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO nodes (id, name, endpoint, api_token, status, node_type, provider, is_protected, created_at, updated_at)
     SELECT 'local', 'Local Node', 'local', '', 'unknown', 'local', 'local-lxc', 1, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE id = 'local' OR endpoint = 'local')`
  ).run(now, now);
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
