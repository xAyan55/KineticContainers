import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import { URL } from "node:url";
import { verifyRequestAuth, sendError, sendJson } from "./auth.js";
import type { AgentConfig } from "./config.js";
import {
  containerExists,
  containerRootfsPath,
  destroyQuietly,
  downloadArch,
  listAllContainers,
  readContainerState,
  runLxc,
  selectBackingStore,
  supportedTemplates,
  templateImage,
  validateContainerId,
  waitForState,
  AgentError,
  getContainerNetwork,
  changeContainerRootPassword,
} from "./services/lxc.js";
import {
  applyResourceLimits,
  ensureLxcfsInclude,
  getContainerMetrics,
  readEffectiveConfig,
} from "./services/cgroup.js";
import {
  enforceBtrfsQuota,
  getContainerDiskUsageGb,
  inspectContainerStorage,
  isBtrfsSubvolume,
} from "./services/storage.js";
import {
  collectHealthCheck,
  getHostCapacity,
  getHostInfo,
} from "./services/host.js";
import { applyRepair, planRepair } from "./services/repair.js";
import { checkConsoleRunnable } from "./services/console.js";
import {
  createEntry,
  deleteEntries,
  listDirectory,
  moveEntry,
  readTextFile,
  resolveContainerPath,
  resolveDownload,
  uploadFiles,
  writeTextFile,
} from "./services/containerFiles.js";
import type { AgentIdentity } from "./types.js";

const AGENT_VERSION = "0.1.0";
const MAX_BODY_BYTES = 16 * 1024 * 1024; // 16MB max

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new AgentError("PAYLOAD_TOO_LARGE", "Request body exceeds 16MB limit.", 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonBody<T = any>(req: IncomingMessage): Promise<T> {
  const text = await readBody(req);
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AgentError("BAD_JSON", "Malformed JSON body.", 400);
  }
}

export function createRequestHandler(config: AgentConfig) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
      const pathname = parsedUrl.pathname.replace(/\/$/, "") || "/";
      const method = req.method?.toUpperCase() ?? "GET";

      // Health endpoint can be public or authenticated. Let's make sure authentication is required
      // for all privileged management endpoints.
      if (!verifyRequestAuth(req, config.authToken)) {
        sendError(res, 401, "UNAUTHORIZED", "Missing or invalid node credentials.");
        return;
      }

      // GET /v1/identity
      if (method === "GET" && pathname === "/v1/identity") {
        const identity: AgentIdentity = {
          nodeId: config.nodeId,
          agentVersion: AGENT_VERSION,
          apiVersions: ["v1"],
          capabilities: {
            create: true,
            start: true,
            stop: true,
            restart: true,
            remove: true,
            liveStatus: true,
            files: true,
            console: true,
            metrics: true,
            repair: true,
            quotas: {
              btrfs: true,
              ext4: true,
            },
          },
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
        };
        sendJson(res, 200, { data: identity });
        return;
      }

      // GET /v1/health
      if (method === "GET" && pathname === "/v1/health") {
        let containersTotal: number | null = null;
        let containersRunning: number | null = null;
        try {
          const list = await listAllContainers();
          containersTotal = list.length;
          containersRunning = list.filter((c) => c.status === "running").length;
        } catch {
          // ignore
        }
        const health = await collectHealthCheck(containersTotal, containersRunning);
        sendJson(res, 200, { data: health });
        return;
      }

      // GET /v1/host/capacity
      if (method === "GET" && pathname === "/v1/host/capacity") {
        const capacity = await getHostCapacity();
        sendJson(res, 200, { data: capacity });
        return;
      }

      // GET /v1/host/templates
      if (method === "GET" && pathname === "/v1/host/templates") {
        sendJson(res, 200, { data: { templates: supportedTemplates() } });
        return;
      }

      // GET /v1/containers
      if (method === "GET" && pathname === "/v1/containers") {
        const containers = await listAllContainers();
        sendJson(res, 200, { data: { containers } });
        return;
      }

      // POST /v1/containers (Provisioning)
      if (method === "POST" && pathname === "/v1/containers") {
        const body = await readJsonBody(req);
        const name = (body.name || "").trim();
        const containerId = (body.containerId || name).trim();
        validateContainerId(containerId);

        const template = (body.template || "").trim();
        const img = templateImage(template);

        const cpu = parseInt(body.cpu, 10);
        if (!Number.isInteger(cpu) || cpu < 1 || cpu > 32) {
          throw new AgentError("INVALID_RESOURCES", "CPU must be between 1 and 32.", 400);
        }

        const memoryMb = parseInt(body.memoryMb, 10);
        if (!Number.isInteger(memoryMb) || memoryMb < 128 || memoryMb > 131072) {
          throw new AgentError("INVALID_RESOURCES", "Memory must be between 128 and 131072 MB.", 400);
        }

        const storageGb = parseInt(body.storageGb, 10);
        if (!Number.isInteger(storageGb) || storageGb < 1 || storageGb > 2000) {
          throw new AgentError("INVALID_RESOURCES", "Storage must be between 1 and 2000 GB.", 400);
        }

        if (await containerExists(containerId)) {
          throw new AgentError("CONTAINER_EXISTS", "A container with this identifier already exists on the host.", 409);
        }

        const arch = downloadArch();
        const backing = await selectBackingStore();
        const createArgs = ["-n", containerId, "-t", "download"];
        if (backing === "btrfs") {
          createArgs.push("-B", "btrfs");
        } else if (backing === "loop") {
          createArgs.push("-B", "loop", "--fstype", "ext4", "--fssize", `${storageGb}G`);
        }

        try {
          await runLxc(
            "lxc-create",
            [...createArgs, "--", "-d", img.distro, "-r", img.release, "-a", arch],
            { timeoutMs: 10 * 60 * 1000, includeStderr: true }
          );
        } catch (err) {
          await destroyQuietly(containerId);
          if (err instanceof AgentError && err.code === "LXC_TIMEOUT") {
            throw new AgentError("CREATE_TIMEOUT", "Container image download timed out.", 504);
          }
          throw err;
        }

        try {
          const state = await readContainerState(containerId).catch(() => "UNKNOWN");
          if (state === "UNKNOWN" && !(await containerExists(containerId))) {
            throw new AgentError("CREATE_FAILED", "Creation completed but container is missing from host.", 500);
          }

          await applyResourceLimits(containerId, { cpu, memoryMb });

          if (backing === "btrfs") {
            const rootfs = resolveContainerPath(containerRootfsPath(containerId), "/");
            if (await isBtrfsSubvolume(rootfs)) {
              await enforceBtrfsQuota(rootfs, storageGb);
            }
          }
          await ensureLxcfsInclude(containerId).catch(() => "unavailable");
        } catch (err) {
          await destroyQuietly(containerId);
          throw err;
        }

        const confirmedState = await readContainerState(containerId).catch(() => "UNKNOWN");
        sendJson(res, 201, {
          data: {
            containerId,
            name,
            status: confirmedState === "RUNNING" ? "running" : "stopped",
          },
        });
        return;
      }

      // Route /v1/containers/:id/...
      const containerMatch = /^\/v1\/containers\/([^/]+)(\/.*)?$/.exec(pathname);
      if (containerMatch) {
        const id = decodeURIComponent(containerMatch[1]);
        validateContainerId(id);
        const subpath = containerMatch[2] || "";

        // GET /v1/containers/:id
        if (method === "GET" && subpath === "") {
          if (!(await containerExists(id))) {
            throw new AgentError("NOT_FOUND", "Container not found on host.", 404);
          }
          const state = await readContainerState(id);
          const network = await getContainerNetwork(id);
          const diskUsageGb = await getContainerDiskUsageGb(id);
          const effective = await readEffectiveConfig(id).catch(() => null);

          sendJson(res, 200, {
            data: {
              containerId: id,
              name: id,
              status: state === "RUNNING" ? "running" : state === "STOPPED" ? "stopped" : state.toLowerCase(),
              ipv4: network.primaryIpv4 ?? undefined,
              cpu: effective?.cpuLimit ?? undefined,
              memoryMb: effective?.memoryMb ?? undefined,
              diskUsageGb: diskUsageGb ?? undefined,
              network,
              config: effective,
            },
          });
          return;
        }

        // POST /v1/containers/:id/start
        if (method === "POST" && subpath === "/start") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const state = await readContainerState(id);
          if (state !== "RUNNING") {
            await runLxc("lxc-start", ["-n", id], { timeoutMs: 60000 });
            await waitForState(id, "RUNNING", 60);
          }
          sendJson(res, 200, { data: { ok: true, status: "running" } });
          return;
        }

        // POST /v1/containers/:id/stop
        if (method === "POST" && subpath === "/stop") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const state = await readContainerState(id);
          if (state !== "STOPPED") {
            await runLxc("lxc-stop", ["-n", id], { timeoutMs: 120000 });
            await waitForState(id, "STOPPED", 90);
          }
          sendJson(res, 200, { data: { ok: true, status: "stopped" } });
          return;
        }

        // POST /v1/containers/:id/restart
        if (method === "POST" && subpath === "/restart") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          await runLxc("lxc-stop", ["-n", id], { timeoutMs: 120000 }).catch(() => undefined);
          await waitForState(id, "STOPPED", 90).catch(() => undefined);
          await runLxc("lxc-start", ["-n", id], { timeoutMs: 60000 });
          await waitForState(id, "RUNNING", 60);
          sendJson(res, 200, { data: { ok: true, status: "running" } });
          return;
        }

        // POST /v1/containers/:id/password
        if (method === "POST" && subpath === "/password") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const body = await readJsonBody<{ password?: string }>(req);
          if (!body.password || typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128) {
            throw new AgentError("INVALID_PASSWORD", "Password must be between 8 and 128 characters.", 400);
          }
          await changeContainerRootPassword(id, body.password);
          sendJson(res, 200, { data: { ok: true, message: "Root password changed successfully." } });
          return;
        }

        // DELETE /v1/containers/:id
        if (method === "DELETE" && subpath === "") {
          if (await containerExists(id)) {
            await runLxc("lxc-destroy", ["-n", id, "-f"], { timeoutMs: 120000 });
            if (await containerExists(id)) {
              throw new AgentError("DESTROY_FAILED", "Destroy ran but container still exists on host.", 500);
            }
          }
          sendJson(res, 200, { data: { ok: true, removed: true } });
          return;
        }

        // GET /v1/containers/:id/state
        if (method === "GET" && subpath === "/state") {
          const exists = await containerExists(id);
          if (!exists) {
            sendJson(res, 200, { data: { exists: false, status: null } });
            return;
          }
          const state = await readContainerState(id);
          const status = state === "RUNNING" ? "running" : state === "STOPPED" ? "stopped" : state.toLowerCase();
          sendJson(res, 200, { data: { exists: true, status, rawState: state } });
          return;
        }

        // GET /v1/containers/:id/network
        if (method === "GET" && subpath === "/network") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const net = await getContainerNetwork(id);
          sendJson(res, 200, { data: net });
          return;
        }

        // GET /v1/containers/:id/metrics
        if (method === "GET" && subpath === "/metrics") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const metrics = await getContainerMetrics(id);
          sendJson(res, 200, { data: metrics });
          return;
        }

        // GET /v1/containers/:id/storage
        if (method === "GET" && subpath === "/storage") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const storage = await inspectContainerStorage(id);
          sendJson(res, 200, { data: storage });
          return;
        }

        // GET /v1/containers/:id/config
        if (method === "GET" && subpath === "/config") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const effective = await readEffectiveConfig(id);
          sendJson(res, 200, { data: effective });
          return;
        }

        // POST /v1/containers/:id/config
        if (method === "POST" && subpath === "/config") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const body = await readJsonBody(req);
          const cpu = body.cpu ? parseInt(body.cpu, 10) : undefined;
          const memoryMb = body.memoryMb ? parseInt(body.memoryMb, 10) : undefined;
          const effective = await applyResourceLimits(id, { cpu: cpu!, memoryMb: memoryMb! });
          sendJson(res, 200, { data: effective });
          return;
        }

        // GET /v1/containers/:id/repair
        if (method === "GET" && subpath === "/repair") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const cpu = parseInt(parsedUrl.searchParams.get("cpu") || "0", 10);
          const memoryMb = parseInt(parsedUrl.searchParams.get("memoryMb") || "0", 10);
          const storageGb = parseInt(parsedUrl.searchParams.get("storageGb") || "0", 10);
          const plan = await planRepair(id, { cpu, memoryMb, storageGb });
          sendJson(res, 200, { data: { plan } });
          return;
        }

        // POST /v1/containers/:id/repair
        if (method === "POST" && subpath === "/repair") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const body = await readJsonBody(req);
          const report = await applyRepair(id, {
            cpu: parseInt(body.cpu, 10),
            memoryMb: parseInt(body.memoryMb, 10),
            storageGb: parseInt(body.storageGb, 10),
          });
          sendJson(res, 200, { data: { report } });
          return;
        }

        // GET /v1/containers/:id/console/check
        if (method === "GET" && subpath === "/console/check") {
          if (!(await containerExists(id))) throw new AgentError("NOT_FOUND", "Container not found.", 404);
          const tpl = parsedUrl.searchParams.get("template") || undefined;
          const preflight = await checkConsoleRunnable(id, tpl);
          sendJson(res, 200, { data: preflight });
          return;
        }

        // File operations: /v1/containers/:id/files...
        if (subpath.startsWith("/files")) {
          const fileSubpath = subpath.slice(6); // after /files

          // GET /v1/containers/:id/files (directory listing)
          if (method === "GET" && (fileSubpath === "" || fileSubpath === "/")) {
            const list = await listDirectory(id, {
              path: parsedUrl.searchParams.get("path") || "/",
              search: parsedUrl.searchParams.get("search") || undefined,
              sort: (parsedUrl.searchParams.get("sort") as any) || undefined,
              order: (parsedUrl.searchParams.get("order") as any) || undefined,
              page: parsedUrl.searchParams.get("page") ? parseInt(parsedUrl.searchParams.get("page")!, 10) : undefined,
              pageSize: parsedUrl.searchParams.get("pageSize") ? parseInt(parsedUrl.searchParams.get("pageSize")!, 10) : undefined,
            });
            sendJson(res, 200, { data: list });
            return;
          }

          // GET /v1/containers/:id/files/content (read text file)
          if (method === "GET" && fileSubpath === "/content") {
            const targetPath = parsedUrl.searchParams.get("path");
            if (!targetPath) throw new AgentError("VALIDATION", "path query parameter is required.", 400);
            const content = await readTextFile(id, targetPath);
            sendJson(res, 200, { data: content });
            return;
          }

          // PUT /v1/containers/:id/files/content (write text file)
          if (method === "PUT" && fileSubpath === "/content") {
            const body = await readJsonBody(req);
            if (!body.path || typeof body.content !== "string") {
              throw new AgentError("VALIDATION", "path and content are required.", 400);
            }
            const result = await writeTextFile(id, body.path, body.content, body.expectedHash);
            sendJson(res, 200, { data: result });
            return;
          }

          // POST /v1/containers/:id/files (create entry)
          if (method === "POST" && (fileSubpath === "" || fileSubpath === "/")) {
            const body = await readJsonBody(req);
            if (!body.path || !body.type || (body.type !== "file" && body.type !== "directory")) {
              throw new AgentError("VALIDATION", "path and type ('file' | 'directory') are required.", 400);
            }
            await createEntry(id, body.path, body.type);
            sendJson(res, 201, { data: { ok: true } });
            return;
          }

          // POST /v1/containers/:id/files/move
          if (method === "POST" && fileSubpath === "/move") {
            const body = await readJsonBody(req);
            if (!body.source || !body.destination) {
              throw new AgentError("VALIDATION", "source and destination paths are required.", 400);
            }
            await moveEntry(id, body.source, body.destination);
            sendJson(res, 200, { data: { ok: true } });
            return;
          }

          // DELETE /v1/containers/:id/files
          if (method === "DELETE" && (fileSubpath === "" || fileSubpath === "/")) {
            const body = await readJsonBody(req);
            const deleted = await deleteEntries(id, body.paths);
            sendJson(res, 200, { data: deleted });
            return;
          }

          // POST /v1/containers/:id/files/upload
          if (method === "POST" && fileSubpath === "/upload") {
            const body = await readJsonBody(req);
            const uploaded = await uploadFiles(id, body.files);
            sendJson(res, 200, { data: uploaded });
            return;
          }

          // GET /v1/containers/:id/files/download
          if (method === "GET" && fileSubpath === "/download") {
            const targetPath = parsedUrl.searchParams.get("path");
            if (!targetPath) throw new AgentError("VALIDATION", "path parameter required.", 400);
            const dl = await resolveDownload(id, targetPath);
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": dl.size,
              "Content-Disposition": `attachment; filename="${dl.filename}"`,
            });
            fs.createReadStream(dl.absPath).pipe(res);
            return;
          }
        }
      }

      sendError(res, 404, "NOT_FOUND", `Endpoint ${method} ${pathname} not found.`);
    } catch (err) {
      if (err instanceof AgentError) {
        sendError(res, err.status, err.code, err.message, err.details);
        return;
      }
      sendError(
        res,
        500,
        "INTERNAL_ERROR",
        err instanceof Error ? err.message : "An unexpected internal error occurred."
      );
    }
  };
}
