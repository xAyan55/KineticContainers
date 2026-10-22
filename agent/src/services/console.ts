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
    reason: pty ? null : "Running in fallback terminal mode (node-pty unavailable).",
  };
}

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 16 * 1024;

export function attachConsoleServer(wss: WebSocketServer): void {
  wss.on("connection", async (ws: WebSocket, req: IncomingMessage, containerId: string, template?: string) => {
    try {
      validateContainerId(containerId);
      const check = await checkConsoleRunnable(containerId, template);
      if (!check.supported || !check.shell) {
        ws.send(JSON.stringify({ type: "error", message: check.reason ?? "Console unavailable." }));
        ws.close(4501, (check.reason ?? "unavailable").slice(0, 120));
        return;
      }

      const shell = check.shell;
      const startCommand = `cd /root 2>/dev/null; exec ${shell}`;
      const pty = loadPty();

      let writeInput: (data: string) => void;
      let resizeTerm: (cols: number, rows: number) => void;
      let killProc: (sig?: string) => void;

      if (pty) {
        const proc = pty.spawn("lxc-attach", ["-n", containerId, "--", shell, "-c", startCommand], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: "/",
          env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" },
        });

        proc.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "output", data }));
          }
        });

        proc.onExit(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "exit" }));
            ws.close(1000, "session ended");
          }
        });

        writeInput = (data) => proc.write(data);
        resizeTerm = (cols, rows) => proc.resize(cols, rows);
        killProc = (sig) => {
          try {
            proc.kill(sig);
          } catch {
            // ignore
          }
        };
      } else {
        // Fallback using child_process spawn
        const proc = spawn("lxc-attach", ["-n", containerId, "--", shell, "-c", startCommand], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" },
        });

        proc.stdout?.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "output", data: chunk.toString("utf8") }));
          }
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "output", data: chunk.toString("utf8") }));
          }
        });

        proc.on("exit", () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "exit" }));
            ws.close(1000, "session ended");
          }
        });

        writeInput = (data) => proc.stdin?.write(data);
        resizeTerm = () => {
          // not supported without pty
        };
        killProc = (sig) => {
          try {
            proc.kill(sig as NodeJS.Signals);
          } catch {
            // ignore
          }
        };
      }

      let idleTimer: NodeJS.Timeout | null = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: "Console idle timeout." }));
          ws.close(4408, "idle");
        }
        killProc("SIGKILL");
      }, IDLE_TIMEOUT_MS);

      const touchIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: "Console idle timeout." }));
            ws.close(4408, "idle");
          }
          killProc("SIGKILL");
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
        }
      });

      const cleanup = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        killProc();
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
