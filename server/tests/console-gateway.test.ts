import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { openTestDb, setDbForTests, newId, nowIso } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";
import {
  attachConsoleGateway,
  __setPtyForTests,
  MAX_SESSIONS_PER_INSTANCE,
} from "../src/services/virtualization/console.js";

interface MockPtyProc {
  pid: number;
  file: string;
  args: string[];
  opts: Record<string, unknown>;
  dataHandlers: ((data: string) => void)[];
  exitHandlers: ((exit: { exitCode: number; signal?: number }) => void)[];
  written: string[];
  resized: { cols: number; rows: number }[];
  killed: boolean;
  killSignal?: string;
}

function createMockPtyLib() {
  const spawned: MockPtyProc[] = [];
  let nextPid = 1000;

  const lib = {
    spawned,
    spawn(file: string, args: string[], opts: Record<string, unknown>) {
      const proc: MockPtyProc = {
        pid: nextPid++,
        file,
        args,
        opts,
        dataHandlers: [],
        exitHandlers: [],
        written: [],
        resized: [{ cols: Number(opts.cols) || 80, rows: Number(opts.rows) || 24 }],
        killed: false,
        killSignal: undefined,
      };

      const ptyProcess = {
        get pid() {
          return proc.pid;
        },
        onData(cb: (d: string) => void) {
          proc.dataHandlers.push(cb);
        },
        onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
          proc.exitHandlers.push(cb);
        },
        write(data: string) {
          proc.written.push(data);
        },
        resize(cols: number, rows: number) {
          proc.resized.push({ cols, rows });
        },
        kill(signal?: string) {
          proc.killed = true;
          proc.killSignal = signal;
        },
      };

      spawned.push(proc);
      return ptyProcess;
    },
  };

  return lib;
}

describe("Console Gateway - Multi-session, PTY isolation and limits", () => {
  let app: ReturnType<typeof createApp>;
  let mockPty: ReturnType<typeof createMockPtyLib>;
  let aliceId = "";
  let aliceInstance = "";
  let aliceCookie = "";

  beforeEach(async () => {
    const db = openTestDb();
    setDbForTests(db);
    vi.stubEnv("CORS_ORIGINS", "");

    mockPty = createMockPtyLib();
    __setPtyForTests(mockPty);

    // Mock readContainerState to report RUNNING
    const localAgent = await import("../src/services/virtualization/localAgent.js");
    vi.spyOn(localAgent, "readContainerState").mockResolvedValue("RUNNING");

    // Seed Alice
    const now = nowIso();
    aliceId = newId("usr");
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', 'active', ?, ?, ?)"
    ).run(aliceId, "alice@test.local", "Alice", await hashPassword("AlicePass12345"), aliceId, now, now);

    aliceInstance = newId("vps");
    db.prepare(
      "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, template, created_at, updated_at) VALUES (?, ?, ?, 'local', ?, 'running', 2, 2048, 20, 'ubuntu-24.04', ?, ?)"
    ).run(aliceInstance, "web-01", "web-01", aliceId, now, now);

    app = createApp();

    // Get cookie
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@test.local", password: "AlicePass12345" });
    const setCookie = loginRes.headers["set-cookie"] as string[];
    aliceCookie = Array.isArray(setCookie) ? setCookie.join("; ") : "";
  });

  afterEach(() => {
    __setPtyForTests(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function connectWs(port: number, query = ""): Promise<{ ws: WebSocket; initialMessages: any[] }> {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${port}/api/instances/${aliceInstance}/console${query}`;
      const ws = new WebSocket(url, {
        headers: {
          Cookie: aliceCookie,
          Origin: "http://127.0.0.1",
        },
      });

      const initialMessages: any[] = [];
      ws.on("message", (raw) => {
        try {
          initialMessages.push(JSON.parse(String(raw)));
        } catch {
          initialMessages.push(String(raw));
        }
      });

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("WebSocket connection timeout"));
      }, 5000);

      ws.on("open", () => {
        clearTimeout(timer);
        resolve({ ws, initialMessages });
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it("spawns independent PTY processes for multiple sessions on the same instance", async () => {
    const srv = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => srv.once("listening", resolve));
    const { port } = srv.address() as AddressInfo;
    attachConsoleGateway(srv);

    // Open session 1
    const s1 = await connectWs(port, "?session=term-1&cols=100&rows=30");
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPty.spawned.length).toBe(1);
    expect(mockPty.spawned[0].opts.cols).toBe(100);
    expect(mockPty.spawned[0].opts.rows).toBe(30);

    // Open session 2
    const s2 = await connectWs(port, "?session=term-2&cols=140&rows=45");
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPty.spawned.length).toBe(2);
    expect(mockPty.spawned[1].opts.cols).toBe(140);
    expect(mockPty.spawned[1].opts.rows).toBe(45);

    // Initial ready messages contain unique sessionIds
    expect(s1.initialMessages.some((m) => m.type === "ready" && m.sessionId === "term-1")).toBe(true);
    expect(s2.initialMessages.some((m) => m.type === "ready" && m.sessionId === "term-2")).toBe(true);

    // Input to session 1 goes ONLY to PTY 1
    s1.ws.send(JSON.stringify({ type: "input", data: "htop\n" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPty.spawned[0].written).toContain("htop\n");
    expect(mockPty.spawned[1].written).not.toContain("htop\n");

    // Input to session 2 goes ONLY to PTY 2
    s2.ws.send(JSON.stringify({ type: "input", data: "tail -f /var/log/syslog\n" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPty.spawned[1].written).toContain("tail -f /var/log/syslog\n");
    expect(mockPty.spawned[0].written).not.toContain("tail -f /var/log/syslog\n");

    // Independent resize
    s1.ws.send(JSON.stringify({ type: "resize", cols: 110, rows: 35 }));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPty.spawned[0].resized).toContainEqual({ cols: 110, rows: 35 });
    expect(mockPty.spawned[1].resized).not.toContainEqual({ cols: 110, rows: 35 });

    // Output from PTY 1 reaches ONLY session 1
    mockPty.spawned[0].dataHandlers.forEach((cb) => cb("Output from Shell 1"));
    await new Promise((r) => setTimeout(r, 50));

    expect(s1.initialMessages.some((m) => m.type === "output" && m.data === "Output from Shell 1")).toBe(true);
    expect(s2.initialMessages.some((m) => m.type === "output" && m.data === "Output from Shell 1")).toBe(false);

    // Close session 1 explicitly with terminate: PTY 1 killed, session 2 untouched
    s1.ws.send(JSON.stringify({ type: "terminate" }));
    await new Promise((r) => setTimeout(r, 100));

    expect(mockPty.spawned[0].killed).toBe(true);
    expect(mockPty.spawned[1].killed).toBe(false);
    expect(s2.ws.readyState).toBe(WebSocket.OPEN);

    // Clean up
    s2.ws.close();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it("enforces concurrent session limit per instance", async () => {
    const srv = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => srv.once("listening", resolve));
    const { port } = srv.address() as AddressInfo;
    attachConsoleGateway(srv);

    const openSockets: WebSocket[] = [];

    // Connect up to MAX_SESSIONS_PER_INSTANCE
    for (let i = 0; i < MAX_SESSIONS_PER_INSTANCE; i++) {
      const { ws } = await connectWs(port, `?session=sess-${i}`);
      openSockets.push(ws);
    }

    expect(mockPty.spawned.length).toBe(MAX_SESSIONS_PER_INSTANCE);

    // Try to open 9th session: must be closed with 4429
    const rejectedOutcome = await new Promise<{ code: number; errorMsg?: string }>((resolve) => {
      const url = `ws://127.0.0.1:${port}/api/instances/${aliceInstance}/console?session=excess`;
      const ws = new WebSocket(url, {
        headers: {
          Cookie: aliceCookie,
          Origin: "http://127.0.0.1",
        },
      });

      let errorMsg = "";
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === "error") errorMsg = msg.message;
        } catch {
          /* ignore */
        }
      });

      ws.on("close", (code) => {
        resolve({ code, errorMsg });
      });

      ws.on("error", () => {
        /* handled by close */
      });
    });

    expect(rejectedOutcome.code).toBe(4429);
    expect(rejectedOutcome.errorMsg).toContain("Maximum concurrent terminal sessions reached");

    // Close one session: now a new session should be accepted
    const first = openSockets.pop();
    first?.close();
    await new Promise((r) => setTimeout(r, 100));

    const { ws: newWs } = await connectWs(port, "?session=sess-replacement");
    expect(newWs.readyState).toBe(WebSocket.OPEN);
    openSockets.push(newWs);

    // Clean up all
    for (const ws of openSockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it("handles ping pong heartbeat", async () => {
    const srv = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => srv.once("listening", resolve));
    const { port } = srv.address() as AddressInfo;
    attachConsoleGateway(srv);

    const { ws, initialMessages } = await connectWs(port, "?session=ping-test");
    ws.send(JSON.stringify({ type: "ping" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(initialMessages.some((m) => m.type === "pong")).toBe(true);

    ws.close();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});
