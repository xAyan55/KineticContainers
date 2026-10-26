import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { getDb, sha256Hex } from "../../db.js";
import { cookieName, type AuthUser } from "../../middleware/auth.js";
import { recordAudit } from "../audit.js";
import { readContainerState } from "./localAgent.js";
import { ProviderError } from "./provider.js";

/**
 * Interactive container console over WebSocket.
 *
 * Security model: every connection re-authenticates the session cookie,
 * re-checks instance ownership in the database, validates the container
 * identifier, and requires the container to be running. The spawned process
 * is fixed to `lxc-attach -n <validated-id> -- <shell> -c "cd /root…; exec <shell>"`
 * (argument array with a constant command string, never user input), so
 * clients can never reach the host shell or
 * arbitrary processes. The pty is killed on disconnect, idle timeout, or
 * session end.
 */

interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exit: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyLib {
  spawn(file: string, args: string[], opts: Record<string, unknown>): PtyProcess;
}

let ptyOverride: PtyLib | null | undefined;
export function __setPtyForTests(lib: PtyLib | null | undefined): void {
  ptyOverride = lib;
}

let ptyLoadError: string | null = null;

/** node-pty is optional: without a working native binding there is no console. */
export function loadPty(): PtyLib | null {
  if (ptyOverride !== undefined) return ptyOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require("node-pty") as PtyLib;
    if (!lib || typeof lib.spawn !== "function") throw new Error("bad node-pty export");
    ptyOverride = lib;
    ptyLoadError = null;
    return lib;
  } catch (err) {
    // Paths only, no secrets — but keep it short for UI display.
    ptyLoadError = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    ptyOverride = null;
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export interface ConsoleSession {
  user: AuthUser;
  row: Record<string, unknown>;
}

/** Cookie auth + ownership check, shared by preflight and the WS handshake. */
export async function authorizeConsole(
  cookieHeader: string | undefined,
  instanceId: string
): Promise<ConsoleSession> {
  const token = parseCookies(cookieHeader)[cookieName()];
  if (!token) {
    throw new ProviderError("UNAUTHENTICATED", "Authentication required.", 401);
  }
  const db = getDb();
  const session = db
    .prepare("SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?")
    .get(sha256Hex(token)) as { id: string; user_id: string; expires_at: string } | undefined;
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    throw new ProviderError("UNAUTHENTICATED", "Authentication required.", 401);
  }
  const user = db
    .prepare("SELECT id, email, name, role, status, avatar_seed, created_at FROM users WHERE id = ?")
    .get(session.user_id) as AuthUser | undefined;
  if (!user || user.status !== "active") {
    throw new ProviderError("UNAUTHENTICATED", "Authentication required.", 401);
  }
  // Use-and-manage scope: administrators may console into any instance,
  // ordinary users only into their own. Unknown ids and (for users) foreign
  // instances are uniformly 404.
  const row =
    user.role === "admin"
      ? (db.prepare("SELECT * FROM instances WHERE id = ?").get(instanceId) as
          | Record<string, unknown>
          | undefined)
      : (db.prepare("SELECT * FROM instances WHERE id = ? AND owner_id = ?").get(instanceId, user.id) as
          | Record<string, unknown>
          | undefined);
  if (!row) {
    throw new ProviderError("NOT_FOUND", "Instance not found.", 404);
  }
  if (!row.node_id || !row.container_id) {
    throw new ProviderError("NO_NODE", "Instance is not attached to a configured node.", 409);
  }
  return { user, row };
}

export interface ConsoleCheck {
  supported: boolean;
  running: boolean;
  shell: string | null;
  reason: string | null;
}

/** Preflight: is an interactive console actually available for this instance? */
export async function checkConsoleRunnable(row: Record<string, unknown>): Promise<ConsoleCheck> {
  const nodeId = String(row.node_id ?? "local");
  const containerId = String(row.container_id ?? "");
  if (nodeId !== "local") {
    const { getProviderForNode } = await import("./providerRegistry.js");
    const provider = getProviderForNode(nodeId);
    return provider.checkConsole(nodeId, containerId, row.template as string | undefined);
  }
  const pty = loadPty();
  if (!pty) {
    const hint = ptyLoadError ? ` (${ptyLoadError})` : "";
    return {
      supported: false,
      running: false,
      shell: null,
      reason: `Console access is unsupported: the terminal backend (node-pty) is unavailable on this host${hint}.`,
    };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$/.test(containerId)) {
    return { supported: false, running: false, shell: null, reason: "Container identifier is invalid." };
  }
  let state = "UNKNOWN";
  try {
    state = await readContainerState(containerId);
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "Could not read container state.";
    return { supported: false, running: false, shell: null, reason: message };
  }
  if (state !== "RUNNING") {
    return {
      supported: false,
      running: false,
      shell: null,
      reason: `Console requires a running container (current state: ${state}).`,
    };
  }
  const template = String(row.template ?? "");
  const shell = template.startsWith("alpine") ? "/bin/sh" : "/bin/bash";
  return { supported: true, running: true, shell, reason: null };
}

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SESSIONS_PER_INSTANCE = Number(process.env.MAX_TERMINAL_SESSIONS_PER_INSTANCE ?? 8);

const activeSessionsByInstance = new Map<string, Set<WebSocket>>();

export function getActiveSessionCount(instanceId: string): number {
  return activeSessionsByInstance.get(instanceId)?.size ?? 0;
}

function registerSession(instanceId: string, ws: WebSocket): boolean {
  let set = activeSessionsByInstance.get(instanceId);
  if (!set) {
    set = new Set();
    activeSessionsByInstance.set(instanceId, set);
  }
  if (set.size >= MAX_SESSIONS_PER_INSTANCE) {
    return false;
  }
  set.add(ws);
  return true;
}

function unregisterSession(instanceId: string, ws: WebSocket): void {
  const set = activeSessionsByInstance.get(instanceId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) activeSessionsByInstance.delete(instanceId);
  }
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function closeWithError(ws: WebSocket, code: number, message: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", message }));
    }
  } catch {
    /* ignore */
  }
  try {
    ws.close(code, message.slice(0, 120));
  } catch {
    /* ignore */
  }
}

function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // non-browser clients have no ambient authority
  const corsOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const lower = origin.toLowerCase();
  if (corsOrigins.some((o) => o && (lower === o || lower.startsWith(o)))) return true;
  if (host) {
    try {
      const parsed = new URL(lower);
      const hosts = host.split(",").map((h) => h.trim().toLowerCase());
      for (const h of hosts) {
        if (parsed.host === h || parsed.hostname === h) return true;
        if (`${parsed.protocol}//${h}` === lower) return true;
        const [hName] = h.split(":");
        if (parsed.hostname === hName) return true;
      }
    } catch {
      const expected = `${lower.startsWith("https") ? "https" : "http"}://${host.toLowerCase()}`;
      if (lower === expected) return true;
    }
  }
  return false;
}

function openConsole(ws: WebSocket, req: IncomingMessage, rawInstanceId: string): void {
  void (async () => {
    const instanceId = decodeURIComponent(rawInstanceId);
    let session: ConsoleSession;
    try {
      session = await authorizeConsole(req.headers.cookie, instanceId);
    } catch (err) {
      const status = err instanceof ProviderError ? err.status : 500;
      closeWithError(ws, status === 401 ? 4401 : 4404, err instanceof Error ? err.message : "Unauthorized.");
      return;
    }

    // Enforce session limit per instance
    if (!registerSession(instanceId, ws)) {
      closeWithError(
        ws,
        4429,
        `Maximum concurrent terminal sessions reached for this VPS (limit: ${MAX_SESSIONS_PER_INSTANCE}). Please close an existing session before opening a new one.`
      );
      return;
    }

    let cleanedUp = false;
    const cleanupSession = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      unregisterSession(instanceId, ws);
    };

    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const clientSessionId = parsedUrl.searchParams.get("session") || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const initCols = Math.max(2, Math.min(500, Math.floor(Number(parsedUrl.searchParams.get("cols")) || 80)));
    const initRows = Math.max(2, Math.min(500, Math.floor(Number(parsedUrl.searchParams.get("rows")) || 24)));

    const { user, row } = session;
    const nodeId = String(row.node_id ?? "local");
    const containerId = String(row.container_id);

    ws.once("close", cleanupSession);
    ws.once("error", cleanupSession);

    if (nodeId !== "local") {
      const { getProviderForNode } = await import("./providerRegistry.js");
      const provider = getProviderForNode(nodeId);
      provider.openConsole(nodeId, containerId, ws, user, row.template as string | undefined, {
        session: clientSessionId,
        cols: initCols,
        rows: initRows,
      });
      return;
    }
    let check: ConsoleCheck;
    try {
      check = await checkConsoleRunnable(row);
    } catch (err) {
      cleanupSession();
      closeWithError(ws, 4502, err instanceof Error ? err.message : "Console check failed.");
      return;
    }
    if (!check.supported || !check.shell) {
      cleanupSession();
      closeWithError(ws, 4501, check.reason ?? "Console unavailable.");
      return;
    }
    const pty = loadPty();
    if (!pty) {
      cleanupSession();
      closeWithError(ws, 4501, "Console backend unavailable.");
      return;
    }
    let proc: PtyProcess;
    try {
      // Start every session in /root (falling back to / when it is missing).
      // The command string is constant — no client input can reach it.
      const shell = check.shell;
      const startCommand = `cd /root 2>/dev/null; exec ${shell}`;
      proc = pty.spawn("lxc-attach", ["-n", containerId, "--", shell, "-c", startCommand], {
        name: "xterm-256color",
        cols: initCols,
        rows: initRows,
        cwd: "/",
        env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" },
      });
    } catch (err) {
      cleanupSession();
      closeWithError(ws, 4502, err instanceof Error ? err.message : "Could not attach to the container.");
      return;
    }
    const db = getDb();
    recordAudit(db, {
      actorId: user.id,
      action: "instance.console_open",
      targetType: "instance",
      targetId: String(row.id),
      detail: { container_id: containerId, session_id: clientSessionId },
    });

    // Notify client the session is ready with shell metadata
    send(ws, {
      type: "ready",
      sessionId: clientSessionId,
      cols: initCols,
      rows: initRows,
      shell: check.shell,
    });

    let closed = false;
    const kill = (signal?: string): void => {
      if (closed) return;
      closed = true;
      try {
        proc.kill(signal ?? "SIGHUP");
      } catch {
        /* ignore */
      }
    };
    let idleTimer: NodeJS.Timeout | null = setTimeout(() => {
      send(ws, { type: "error", message: "Console idle timeout." });
      try {
        ws.close(4408, "idle");
      } catch {
        /* ignore */
      }
      kill("SIGKILL");
    }, IDLE_TIMEOUT_MS);
    const touchIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        send(ws, { type: "error", message: "Console idle timeout." });
        try {
          ws.close(4408, "idle");
        } catch {
          /* ignore */
        }
        kill("SIGKILL");
      }, IDLE_TIMEOUT_MS);
    };

    proc.onData((data: string) => {
      // Backpressure protection: avoid unbounded memory buffer if client is stalled
      if (ws.bufferedAmount > 1024 * 1024) {
        return;
      }
      send(ws, { type: "output", data });
    });
    proc.onExit((exit) => {
      send(ws, { type: "exit", code: exit?.exitCode ?? 0 });
      if (idleTimer) clearTimeout(idleTimer);
      try {
        ws.close(1000, "session ended");
      } catch {
        /* ignore */
      }
      cleanupSession();
    });
    ws.on("message", (raw: Buffer | string) => {
      let msg: { type?: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string") {
        touchIdle();
        try {
          proc.write(msg.data.slice(0, MAX_PAYLOAD_BYTES));
        } catch {
          /* ignore */
        }
      } else if (msg.type === "resize") {
        const cols = Math.max(2, Math.min(500, Math.floor(Number(msg.cols) || 80)));
        const rows = Math.max(2, Math.min(500, Math.floor(Number(msg.rows) || 24)));
        try {
          proc.resize(cols, rows);
        } catch {
          /* ignore */
        }
      } else if (msg.type === "terminate") {
        if (idleTimer) clearTimeout(idleTimer);
        kill("SIGHUP");
        try {
          ws.close(1000, "terminated");
        } catch {
          /* ignore */
        }
        cleanupSession();
      } else if (msg.type === "ping") {
        send(ws, { type: "pong" });
      }
    });
    const onClose = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      kill();
      cleanupSession();
    };
    ws.on("close", onClose);
    ws.on("error", onClose);
  })();
}

/** Mount the console gateway on an existing HTTP server. Unknown paths are refused. */
export function attachConsoleGateway(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const pathname = (req.url ?? "/").split("?")[0];
    const m = /^\/api\/instances\/([^/]+)\/console$/.exec(pathname);
    if (!m) {
      try {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    const fwdHost = Array.isArray(req.headers["x-forwarded-host"]) ? req.headers["x-forwarded-host"][0] : req.headers["x-forwarded-host"];
    const rawHost = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
    const host = fwdHost || rawHost;
    if (!originAllowed(origin, host)) {
      try {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => openConsole(ws, req, m[1]));
  });
}
