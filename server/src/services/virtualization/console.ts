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
 * is fixed to `lxc-attach -n <validated-id> -- <shell>` (argument array,
 * never a shell string), so clients can never reach the host shell or
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
  const containerId = String(row.container_id);
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
  if (host) {
    try {
      const expected = `${lower.startsWith("https") ? "https" : "http"}://${host.toLowerCase()}`;
      if (lower === expected) return true;
    } catch {
      return false;
    }
  }
  return corsOrigins.some((o) => o && lower.startsWith(o));
}

function openConsole(ws: WebSocket, req: IncomingMessage, instanceId: string): void {
  void (async () => {
    let session: ConsoleSession;
    try {
      session = await authorizeConsole(req.headers.cookie, decodeURIComponent(instanceId));
    } catch (err) {
      const status = err instanceof ProviderError ? err.status : 500;
      closeWithError(ws, status === 401 ? 4401 : 4404, err instanceof Error ? err.message : "Unauthorized.");
      return;
    }
    const { user, row } = session;
    const containerId = String(row.container_id);
    let check: ConsoleCheck;
    try {
      check = await checkConsoleRunnable(row);
    } catch (err) {
      closeWithError(ws, 4502, err instanceof Error ? err.message : "Console check failed.");
      return;
    }
    if (!check.supported || !check.shell) {
      closeWithError(ws, 4501, check.reason ?? "Console unavailable.");
      return;
    }
    const pty = loadPty();
    if (!pty) {
      closeWithError(ws, 4501, "Console backend unavailable.");
      return;
    }
    let proc: PtyProcess;
    try {
      proc = pty.spawn("lxc-attach", ["-n", containerId, "--", check.shell], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: "/",
        env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" },
      });
    } catch (err) {
      closeWithError(ws, 4502, err instanceof Error ? err.message : "Could not attach to the container.");
      return;
    }
    const db = getDb();
    recordAudit(db, {
      actorId: user.id,
      action: "instance.console_open",
      targetType: "instance",
      targetId: String(row.id),
      detail: { container_id: containerId },
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
      send(ws, { type: "output", data });
    });
    proc.onExit(() => {
      send(ws, { type: "exit" });
      if (idleTimer) clearTimeout(idleTimer);
      try {
        ws.close(1000, "session ended");
      } catch {
        /* ignore */
      }
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
      }
    });
    const onClose = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      kill();
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
    const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
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
