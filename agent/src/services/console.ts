import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { readContainerState, validateContainerId, AgentError } from "./lxc.js";
import type { ConsoleCheck } from "../types.js";

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

let ptyLib: PtyLib | null | undefined;

export function loadPty(): PtyLib | null {
  if (ptyLib !== undefined) return ptyLib;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require("node-pty") as PtyLib;
    if (lib && typeof lib.spawn === "function") {
      ptyLib = lib;
      return lib;
    }
  } catch {
    // optional dependency
  }
  ptyLib = null;
  return null;
}

export function setPtyForTests(lib: PtyLib | null): void {
  ptyLib = lib;
}

export async function checkConsoleRunnable(containerId: string, template?: string): Promise<ConsoleCheck> {
  validateContainerId(containerId);
  const pty = loadPty();

  if (!pty) {
    return {
      supported: false,
      running: false,
      shell: null,
      reason: "Console access is unsupported: node-pty is unavailable on this remote agent host. Install build-essential and rebuild agent dependencies.",
    };
  }

  let state = "UNKNOWN";
  try {
    state = await readContainerState(containerId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read container state.";
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

  const shell = template?.startsWith("alpine") ? "/bin/sh" : "/bin/bash";
  return {
    supported: true,
    running: true,
    shell,
    reason: null,
  };
}

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SESSIONS_PER_CONTAINER = 8;

const activeSessionsByContainer = new Map<string, Set<WebSocket>>();

function registerSession(containerId: string, ws: WebSocket): boolean {
  let set = activeSessionsByContainer.get(containerId);
  if (!set) {
    set = new Set();
    activeSessionsByContainer.set(containerId, set);
  }
  if (set.size >= MAX_SESSIONS_PER_CONTAINER) {
    return false;
  }
  set.add(ws);
  return true;
}

function unregisterSession(containerId: string, ws: WebSocket): void {
  const set = activeSessionsByContainer.get(containerId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) activeSessionsByContainer.delete(containerId);
  }
}

export function attachConsoleServer(wss: WebSocketServer): void {
  wss.on("connection", async (ws: WebSocket, req: IncomingMessage, containerId: string, template?: string) => {
    try {
      validateContainerId(containerId);

      if (!registerSession(containerId, ws)) {
        ws.send(JSON.stringify({
          type: "error",
          message: `Maximum concurrent terminal sessions reached for this container (limit: ${MAX_SESSIONS_PER_CONTAINER}).`,
        }));
        ws.close(4429, "session limit reached");
        return;
      }

      let cleanedUp = false;
      const cleanupSession = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        unregisterSession(containerId, ws);
      };

      ws.once("close", cleanupSession);
      ws.once("error", cleanupSession);

      const check = await checkConsoleRunnable(containerId, template);
      if (!check.supported || !check.shell) {
        ws.send(JSON.stringify({ type: "error", message: check.reason ?? "Console unavailable." }));
        ws.close(4501, (check.reason ?? "unavailable").slice(0, 120));
        cleanupSession();
        return;
      }

      const pty = loadPty();
      if (!pty) {
        ws.send(JSON.stringify({ type: "error", message: "Console backend unavailable (node-pty missing)." }));
        ws.close(4501, "node-pty missing");
        cleanupSession();
        return;
      }

      const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const clientSessionId = parsedUrl.searchParams.get("session") || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const initCols = Math.max(2, Math.min(500, Math.floor(Number(parsedUrl.searchParams.get("cols")) || 80)));
      const initRows = Math.max(2, Math.min(500, Math.floor(Number(parsedUrl.searchParams.get("rows")) || 24)));

      const shell = check.shell;
      const startCommand = `cd /root 2>/dev/null; exec ${shell}`;

      const proc = pty.spawn("lxc-attach", ["-n", containerId, "--", shell, "-c", startCommand], {
        name: "xterm-256color",
        cols: initCols,
        rows: initRows,
        cwd: "/",
        env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" },
      });

      // Notify client that session is ready
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "ready",
          sessionId: clientSessionId,
          cols: initCols,
          rows: initRows,
          shell,
        }));
      }

      proc.onData((data) => {
        if (ws.bufferedAmount > 1024 * 1024) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "output", data }));
        }
      });

      proc.onExit((exit) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "exit", code: exit?.exitCode ?? 0 }));
          ws.close(1000, "session ended");
        }
        cleanupSession();
      });

      const writeInput = (data: string) => proc.write(data);
      const resizeTerm = (cols: number, rows: number) => proc.resize(cols, rows);
      const killProc = (sig?: string) => {
        try {
          proc.kill(sig);
        } catch {
          // ignore
        }
      };

      let idleTimer: NodeJS.Timeout | null = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: "Console idle timeout." }));
          ws.close(4408, "idle");
        }
        killProc("SIGKILL");
        cleanupSession();
      }, IDLE_TIMEOUT_MS);

      const touchIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: "Console idle timeout." }));
            ws.close(4408, "idle");
          }
          killProc("SIGKILL");
          cleanupSession();
        }, IDLE_TIMEOUT_MS);
      };

      ws.on("message", (raw) => {
        let msg: { type?: string; data?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === "input" && typeof msg.data === "string") {
          touchIdle();
          writeInput(msg.data.slice(0, MAX_PAYLOAD_BYTES));
        } else if (msg.type === "resize") {
          const cols = Math.max(2, Math.min(500, Math.floor(Number(msg.cols) || 80)));
          const rows = Math.max(2, Math.min(500, Math.floor(Number(msg.rows) || 24)));
          resizeTerm(cols, rows);
        } else if (msg.type === "terminate") {
          if (idleTimer) clearTimeout(idleTimer);
          killProc("SIGHUP");
          ws.close(1000, "terminated");
          cleanupSession();
        } else if (msg.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        }
      });

      const cleanup = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        killProc();
        cleanupSession();
      };

      ws.on("close", cleanup);
      ws.on("error", cleanup);
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "Internal error." }));
        ws.close(4500, "error");
      }
    }
  });
}
