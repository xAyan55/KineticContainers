import https from "node:https";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig, ensureTlsCertificates } from "./config.js";
import { createRequestHandler } from "./router.js";
import { attachConsoleServer } from "./services/console.js";
import { verifyRequestAuth } from "./auth.js";

export function startAgent(argv: string[] = process.argv.slice(2)): {
  server: https.Server;
  close: () => Promise<void>;
} {
  const config = loadConfig(argv);

  if (!config.nodeId) {
    console.warn("[WARN] Agent started without an assigned nodeId. Enrollment required.");
  }
  if (!config.authToken) {
    console.warn("[WARN] Agent started without an authToken. Requests will be rejected until configured.");
  }

  const { cert, key } = ensureTlsCertificates(config.certPath, config.keyPath);
  const requestHandler = createRequestHandler(config);

  const server = https.createServer({ cert, key }, requestHandler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  attachConsoleServer(wss);

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
      const pathname = parsedUrl.pathname.replace(/\/$/, "");

      const match = /^\/v1\/containers\/([^/]+)\/console$/.exec(pathname);
      if (!match) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      // Check auth from headers or token query parameter
      const tokenParam = parsedUrl.searchParams.get("token");
      let authorized = verifyRequestAuth(req, config.authToken);
      if (!authorized && tokenParam && config.authToken) {
        authorized = tokenParam === config.authToken;
      }

      if (!authorized) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const containerId = decodeURIComponent(match[1]);
      const template = parsedUrl.searchParams.get("template") || undefined;

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, containerId, template);
      });
    } catch {
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  });

  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`[KineticCT Agent] Listening securely on https://${config.listenHost}:${config.listenPort}`);
    console.log(`[KineticCT Agent] Node ID: ${config.nodeId || "unconfigured"}`);
    console.log(`[KineticCT Agent] PID: ${process.pid}`);
  });

  const close = (): Promise<void> => {
    return new Promise((resolve) => {
      wss.close(() => {
        server.close(() => {
          resolve();
        });
      });
    });
  };

  return { server, close };
}

if (require.main === module) {
  const { server } = startAgent();
  const shutdown = (): void => {
    console.log("[KineticCT Agent] Shutting down gracefully...");
    server.close(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
