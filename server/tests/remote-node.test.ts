import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import https from "node:https";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { openTestDb, setDbForTests, getDb, newId, nowIso } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";
import { getProviderForNode, UnconfiguredRemoteProvider } from "../src/services/virtualization/providerRegistry.js";
import { RemoteAgentProvider } from "../src/services/virtualization/remoteProvider.js";
import { LocalLxcProvider } from "../src/services/virtualization/localAgent.js";
import { encryptSecret, decryptSecret } from "../src/services/crypto.js";
import { ensureTlsCertificates } from "../../agent/src/config.js";
import path from "node:path";
import os from "node:os";

async function makeAdmin(db: ReturnType<typeof openTestDb>): Promise<string> {
  const id = newId("usr");
  const now = nowIso();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?, ?)"
  ).run(id, "admin@test.local", "Admin", await hashPassword("AdminPass12345"), "admin", now, now);
  return id;
}

async function makeUser(db: ReturnType<typeof openTestDb>): Promise<string> {
  const id = newId("usr");
  const now = nowIso();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', 'active', ?, ?, ?)"
  ).run(id, "user@test.local", "User", await hashPassword("UserPass12345"), "user", now, now);
  return id;
}

describe("Remote Node System", () => {
  let app: ReturnType<typeof createApp>;
  let mockServer: https.Server | null = null;
  let mockPort = 0;
  let adminId = "";
  let receivedRequests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: any;
  }> = [];

  const mockAgentToken = "test-node-agent-credential-secure-high-entropy";

  beforeEach(async () => {
    const db = openTestDb();
    setDbForTests(db);
    vi.stubEnv("CORS_ORIGINS", "");
    adminId = await makeAdmin(db);
    await makeUser(db);
    app = createApp();
    receivedRequests = [];

    // Set up a mock HTTPS server simulating KineticCT Remote Node Agent
    const tmpCertDir = path.join(os.tmpdir(), "kct-test-certs-" + Math.random().toString(36).slice(2));
    const certPath = path.join(tmpCertDir, "cert.pem");
    const keyPath = path.join(tmpCertDir, "key.pem");
    const { cert, key } = ensureTlsCertificates(certPath, keyPath);

    mockServer = https.createServer({ cert, key }, (req, res) => {
      let bodyBuf = "";
      req.on("data", (chunk) => {
        bodyBuf += chunk.toString();
      });
      req.on("end", () => {
        let parsedBody: any = null;
        try {
          parsedBody = bodyBuf ? JSON.parse(bodyBuf) : null;
        } catch {
          parsedBody = bodyBuf;
        }

        const reqRecord = {
          method: req.method || "GET",
          url: req.url || "/",
          headers: req.headers,
          body: parsedBody,
        };
        receivedRequests.push(reqRecord);

        // Verify Bearer Auth
        const auth = req.headers["authorization"];
        if (!auth || auth !== `Bearer ${mockAgentToken}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid node credentials." } }));
          return;
        }

        const url = req.url || "/";

        // Route handlers
        if (url === "/v1/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                status: "online",
                ok: true,
                checkedAt: new Date().toISOString(),
                detail: "Host agent reachable; LXC tools responded.",
                checks: {
                  lxcInstalled: true,
                  commandsOk: true,
                  permissionsOk: true,
                  inventoryOk: true,
                  resourcesOk: true,
                },
                host: {
                  hostname: "remote-nat-vps",
                  platform: "linux",
                  osName: "Ubuntu",
                  osVersion: "24.04",
                  kernel: "6.8.0-45-generic",
                  arch: "x64",
                  memoryTotalMb: 16384,
                  memoryUsedMb: 4096,
                  memoryFreeMb: 12288,
                  cpuCount: 4,
                  cpuModel: "AMD EPYC",
                  cpuPercent: 12.5,
                  load1: 0.15,
                  rootTotalGb: 100,
                  rootUsedGb: 25,
                  rootAvailGb: 75,
                },
                hostCapabilities: {
                  lxcInstalled: true,
                  lxcVersion: "5.0.3",
                  nestedGuest: null,
                  restrictedGuest: false,
                  userNamespaces: true,
                  cgroup: "v2",
                  bridgePresent: true,
                  ipForwarding: true,
                  runtimeUid: 0,
                  lxcfsActive: true,
                },
                containersTotal: 1,
                containersRunning: 1,
              },
            })
          );
          return;
        }

        if (url === "/v1/identity") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                nodeId: "mock-remote-node",
                agentVersion: "0.1.0",
                hostname: "remote-nat-vps",
                platform: "linux",
                osName: "Ubuntu",
                osVersion: "24.04",
                kernel: "6.8.0-45-generic",
                arch: "x64",
                lxcInstalled: true,
                lxcVersion: "5.0.3",
                capabilities: {
                  create: true,
                  start: true,
                  stop: true,
                  restart: true,
                  delete: true,
                  metrics: true,
                  files: true,
                  console: true,
                },
              },
            })
          );
          return;
        }

        if (url === "/v1/host/resources") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                memoryTotalMb: 16384,
                memoryUsedMb: 4096,
                memoryFreeMb: 12288,
                cpuCount: 4,
                cpuModel: "AMD EPYC",
                cpuPercent: 12.5,
                load1: 0.15,
                rootTotalGb: 100,
                rootUsedGb: 25,
                rootAvailGb: 75,
              },
            })
          );
          return;
        }

        if (url === "/v1/host/capacity") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                memoryTotalMb: 16384,
                memoryAvailableMb: 12288,
                cpuCores: 4,
                cpuUsagePercent: 12.5,
                diskTotalBytes: 107374182400,
                diskAvailableBytes: 80530636800,
              },
            })
          );
          return;
        }

        if (url === "/v1/host/templates") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                templates: ["ubuntu-22.04", "debian-12", "alpine-3.20"],
              },
            })
          );
          return;
        }

        if (url === "/v1/containers" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                containers: [
                  {
                    id: "ct-remote-100",
                    name: "test-vps-remote",
                    status: "running",
                    ipv4: "10.0.3.50",
                  },
                ],
              },
            })
          );
          return;
        }

        if (url === "/v1/containers" && req.method === "POST") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                containerId: parsedBody?.name || "ct-remote-new",
                status: "running",
                created: true,
              },
            })
          );
          return;
        }

        if (url.startsWith("/v1/containers/") && url.endsWith("/start") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { success: true, status: "running" } }));
          return;
        }

        if (url.startsWith("/v1/containers/") && url.endsWith("/stop") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { success: true, status: "stopped" } }));
          return;
        }

        if (url.startsWith("/v1/containers/") && url.endsWith("/resources") && req.method === "PATCH") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { updated: true, limits: parsedBody } }));
          return;
        }

        if (url.startsWith("/v1/containers/") && req.method === "DELETE") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { deleted: true } }));
          return;
        }

        if (url.includes("/files") && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                entries: [
                  { name: "test.txt", path: "/test.txt", type: "file", size: 12, mtime: new Date().toISOString() },
                ],
              },
            })
          );
          return;
        }

        if (url.startsWith("/v1/containers/") && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                id: "ct-remote-100",
                status: "running",
                pid: 1234,
                ipv4: "10.0.3.50",
              },
            })
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Mock endpoint not found." } }));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer!.listen(0, "127.0.0.1", () => {
        mockPort = (mockServer!.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => {
        mockServer!.close(() => resolve());
      });
      mockServer = null;
    }
  });

  describe("Provider resolution and isolation", () => {
    it("returns LocalLxcProvider for the protected Local Node", () => {
      const provider = getProviderForNode("local");
      expect(provider).toBeInstanceOf(LocalLxcProvider);
      expect(provider.kind).toBe("local-lxc");
    });

    it("fails with ProviderError when node does not exist", () => {
      expect(() => getProviderForNode("non_existent_node")).toThrowError(/is not registered/);
    });

    it("returns UnconfiguredRemoteProvider when node is missing authentication credential", () => {
      const db = getDb();
      const id = newId("node");
      db.prepare(
        "INSERT INTO nodes (id, name, endpoint, status, node_type, provider, created_at, updated_at) VALUES (?, 'Unconfigured', 'https://node.example.com', 'unconfigured', 'remote', 'remote-agent', ?, ?)"
      ).run(id, nowIso(), nowIso());

      const provider = getProviderForNode(id);
      expect(provider).toBeInstanceOf(UnconfiguredRemoteProvider);
      expect(provider.capabilities.create).toBe(false);
      expect(provider.capabilities.start).toBe(false);
    });

    it("returns RemoteAgentProvider when node has valid configuration and encrypted credentials", () => {
      const db = getDb();
      const id = newId("node");
      const encCred = encryptSecret(mockAgentToken);
      db.prepare(
        "INSERT INTO nodes (id, name, endpoint, auth_credential, status, node_type, provider, tls_skip_verify, created_at, updated_at) VALUES (?, 'Remote Node', ?, ?, 'online', 'remote', 'remote-agent', 1, ?, ?)"
      ).run(id, `https://127.0.0.1:${mockPort}`, encCred, nowIso(), nowIso());

      const provider = getProviderForNode(id);
      expect(provider).toBeInstanceOf(RemoteAgentProvider);
      expect(provider.kind).toBe("remote-agent");
    });
  });

  describe("Authentication, credentials, and endpoint validation", () => {
    it("rejects loopback addresses for remote nodes unless explicitly enabled for tests", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });

      const res = await agent.post("/api/nodes").send({
        name: "Loopback VPS",
        connection: "remote",
        endpoint: "https://localhost:5433",
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/must use a public HTTPS hostname.*not a loopback address/);
    });

    it("rejects non-HTTPS URLs and URLs with embedded credentials", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });

      const httpRes = await agent.post("/api/nodes").send({
        name: "Insecure HTTP",
        connection: "remote",
        endpoint: "http://node.example.com",
      });
      expect(httpRes.status).toBe(400);
      expect(httpRes.body.error.message).toMatch(/must use HTTPS/);

      const embedRes = await agent.post("/api/nodes").send({
        name: "Embedded Creds",
        connection: "remote",
        endpoint: "https://user:pass@node.example.com",
      });
      expect(embedRes.status).toBe(400);
      expect(embedRes.body.error.message).toMatch(/Embedded credentials.*not allowed/);
    });

    it("generates a high-entropy credential upon registration and never exposes plaintext in subsequent queries", async () => {
      vi.stubEnv("ALLOW_LOOPBACK_NODES", "1");
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });

      const regRes = await agent.post("/api/nodes").send({
        name: "Production Tunnel Node",
        connection: "remote",
        endpoint: `https://127.0.0.1:${mockPort}`,
        tls_skip_verify: true,
      });

      expect(regRes.status).toBe(201);
      expect(regRes.body.data.credential).toBeTruthy();
      expect(typeof regRes.body.data.credential).toBe("string");
      expect(regRes.body.data.credential.length).toBeGreaterThanOrEqual(32);

      const nodeId = regRes.body.data.node.id;

      // Querying the node list or detail MUST NOT return auth_credential or credential
      const getRes = await agent.get(`/api/nodes/${nodeId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.node.auth_credential).toBeUndefined();
      expect(getRes.body.data.node.credential).toBeUndefined();
      expect(getRes.body.data.node.api_token).toBeUndefined();
      expect(getRes.body.data.node.has_auth_credential).toBe(true);
    });

    it("rotates credentials securely, generating a new secret and invalidating the previous one", async () => {
      const db = getDb();
      const nodeId = newId("node");
      const initialSecret = "initial-secret-12345678901234567890";
      db.prepare(
        "INSERT INTO nodes (id, name, endpoint, auth_credential, status, node_type, provider, created_at, updated_at) VALUES (?, 'Node to Rotate', 'https://remote.example.com', ?, 'online', 'remote', 'remote-agent', ?, ?)"
      ).run(nodeId, encryptSecret(initialSecret), nowIso(), nowIso());

      const agent = request.agent(app);
      const login = await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
      expect(login.status).toBe(200);

      const rotateRes = await agent.post(`/api/nodes/${nodeId}/rotate-credential`);
      expect(rotateRes.status).toBe(200);
      expect(rotateRes.body.data.credential).toBeTruthy();
      expect(rotateRes.body.data.credential).not.toBe(initialSecret);

      // Verify that the stored credential in database was updated
      const row = db.prepare("SELECT auth_credential FROM nodes WHERE id = ?").get(nodeId) as {
        auth_credential: string;
      };
      const decrypted = decryptSecret(row.auth_credential);
      expect(decrypted).toBe(rotateRes.body.data.credential);
      expect(decrypted).not.toBe(initialSecret);
    });
  });

  describe("TLS verification and Cloudflare Access scoping", () => {
    it("fails with TLS error when connecting to self-signed mock agent with tls_skip_verify: false", async () => {
      const db = getDb();
      const nodeId = newId("node");
      db.prepare(
        "INSERT INTO nodes (id, name, endpoint, auth_credential, status, node_type, provider, tls_skip_verify, created_at, updated_at) VALUES (?, 'Strict TLS Node', ?, ?, 'unknown', 'remote', 'remote-agent', 0, ?, ?)"
      ).run(nodeId, `https://127.0.0.1:${mockPort}`, encryptSecret(mockAgentToken), nowIso(), nowIso());

      const agent = request.agent(app);
      const login = await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
      expect(login.status).toBe(200);

      const checkRes = await agent.post(`/api/nodes/${nodeId}/test`);
      // Since it's an untrusted self-signed certificate and verification is enabled, request fails
      expect(checkRes.status).toBe(502);
      expect(checkRes.body.error.message).toMatch(/certificate|TLS|depth/i);
    });

    it("succeeds when tls_skip_verify: true is set on the specific node", async () => {
      const db = getDb();
      const nodeId = newId("node");
      db.prepare(
        "INSERT INTO nodes (id, name, endpoint, auth_credential, status, node_type, provider, tls_skip_verify, created_at, updated_at) VALUES (?, 'Skip Verify Node', ?, ?, 'unknown', 'remote', 'remote-agent', 1, ?, ?)"
      ).run(nodeId, `https://127.0.0.1:${mockPort}`, encryptSecret(mockAgentToken), nowIso(), nowIso());

      const agent = request.agent(app);
      const login = await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
      expect(login.status).toBe(200);

      const checkRes = await agent.post(`/api/nodes/${nodeId}/check`);
      expect(checkRes.status).toBe(200);
      expect(checkRes.body.data.check.ok).toBe(true);
      expect(checkRes.body.data.check.status).toBe("online");
    });

    it("attaches Cloudflare Access headers strictly to outbound requests when configured", async () => {
      const db = getDb();
      const nodeId = newId("node");
      db.prepare(
        `INSERT INTO nodes (
           id, name, endpoint, auth_credential, status, node_type, provider, tls_skip_verify,
           cf_client_id, cf_client_secret, created_at, updated_at
         ) VALUES (?, 'CF Access Node', ?, ?, 'unknown', 'remote', 'remote-agent', 1, 'cf-client-id-123', ?, ?, ?)`
      ).run(nodeId, `https://127.0.0.1:${mockPort}`, encryptSecret(mockAgentToken), encryptSecret("cf-client-secret-xyz"), nowIso(), nowIso());

      const agent = request.agent(app);
      const login = await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
      expect(login.status).toBe(200);

      receivedRequests = [];
      const testRes = await agent.post(`/api/nodes/${nodeId}/test`);
      expect(testRes.status).toBe(200);

      // Verify received request headers at the mock agent
      expect(receivedRequests.length).toBeGreaterThanOrEqual(1);
      const lastReq = receivedRequests[receivedRequests.length - 1];
      expect(lastReq.headers["cf-access-client-id"]).toBe("cf-client-id-123");
      expect(lastReq.headers["cf-access-client-secret"]).toBe("cf-client-secret-xyz");
      expect(lastReq.headers["authorization"]).toBe(`Bearer ${mockAgentToken}`);
    });
  });

  describe("Remote container lifecycle and operations", () => {
    let remoteNodeId: string;

    beforeEach(() => {
      const db = getDb();
      remoteNodeId = newId("node");
      db.prepare(
        "INSERT INTO nodes (id, name, endpoint, auth_credential, status, node_type, provider, tls_skip_verify, created_at, updated_at) VALUES (?, 'Remote VPS', ?, ?, 'online', 'remote', 'remote-agent', 1, ?, ?)"
      ).run(remoteNodeId, `https://127.0.0.1:${mockPort}`, encryptSecret(mockAgentToken), nowIso(), nowIso());
    });

    it("provisions an instance onto the remote node through the remote agent", async () => {
      const agent = request.agent(app);
      const login = await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
      expect(login.status).toBe(200);

      receivedRequests = [];
      const createRes = await agent.post("/api/admin/instances").send({
        name: "remotetest",
        node_id: remoteNodeId,
        owner_id: adminId,
        template: "ubuntu-22.04",
        cpu: 2,
        memory_mb: 2048,
        storage_gb: 20,
      });

      expect(createRes.status).toBe(201);
      const inst = createRes.body.data.instance;
      expect(inst.node_id).toBe(remoteNodeId);
      expect(inst.status).toBe("running");

      // Verify that the mock remote agent received container creation requests
      const createReq = receivedRequests.find((r) => r.method === "POST" && r.url === "/v1/containers");
      expect(createReq).toBeTruthy();
      expect(createReq?.body?.template).toBe("ubuntu-22.04");
    });

    it("dispatches power operations (stop, start) to the remote node agent", async () => {
      const db = getDb();
      const instId = newId("vps");
      db.prepare(
        "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, created_at, updated_at) VALUES (?, 'Managed Remote VPS', 'ct-remote-100', ?, ?, 'running', 2, 2048, 20, ?, ?)"
      ).run(instId, remoteNodeId, adminId, nowIso(), nowIso());

      const agent = request.agent(app);
      const login = await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
      expect(login.status).toBe(200);

      receivedRequests = [];
      const stopRes = await agent.post(`/api/instances/${instId}/actions`).send({ action: "stop" });
      expect(stopRes.status).toBe(200);

      // Verify agent received POST /v1/containers/ct-remote-100/stop
      const stopReq = receivedRequests.find(
        (r) => r.method === "POST" && r.url.includes("/v1/containers/ct-remote-100/stop")
      );
      expect(stopReq).toBeTruthy();
    });

    it("routes file operations to the remote agent filesystem", async () => {
      const db = getDb();
      const instId = newId("vps");
      db.prepare(
        "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, created_at, updated_at) VALUES (?, 'File VPS', 'ct-remote-100', ?, ?, 'running', 2, 2048, 20, ?, ?)"
      ).run(instId, remoteNodeId, adminId, nowIso(), nowIso());

      const agent = request.agent(app);
      const login = await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
      expect(login.status).toBe(200);

      receivedRequests = [];
      const filesRes = await agent.get(`/api/instances/${instId}/files?path=/`);
      expect(filesRes.status).toBe(200);
      expect(filesRes.body.data.entries).toBeTruthy();
      expect(filesRes.body.data.entries[0].name).toBe("test.txt");

      // Verify agent received GET /v1/containers/ct-remote-100/files
      const filesReq = receivedRequests.find((r) => r.method === "GET" && r.url.includes("/files"));
      expect(filesReq).toBeTruthy();
    });

    it("deletes the remote container from the remote host and removes the DB record", async () => {
      const db = getDb();
      const instId = newId("vps");
      db.prepare(
        "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, created_at, updated_at) VALUES (?, 'Delete VPS', 'ct-remote-100', ?, ?, 'running', 2, 2048, 20, ?, ?)"
      ).run(instId, remoteNodeId, adminId, nowIso(), nowIso());

      const agent = request.agent(app);
      const login = await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
      expect(login.status).toBe(200);

      receivedRequests = [];
      const delRes = await agent.delete(`/api/instances/${instId}`);
      expect(delRes.status).toBe(200);

      // Verify agent received DELETE /v1/containers/ct-remote-100
      const delReq = receivedRequests.find(
        (r) => r.method === "DELETE" && r.url.includes("/v1/containers/ct-remote-100")
      );
      expect(delReq).toBeTruthy();

      // Database record should be gone
      const remaining = db.prepare("SELECT id FROM instances WHERE id = ?").get(instId);
      expect(remaining).toBeUndefined();
    });
  });
});
