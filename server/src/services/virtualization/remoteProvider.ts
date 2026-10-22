import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import type { AuthUser } from "../../middleware/auth.js";
import {
  ProviderError,
  type ConsoleCheck,
  type ContainerInfo,
  type ContainerMetrics,
  type ContainerNetworkInfo,
  type ContainerStorageInfo,
  type CreateContainerRequest,
  type DeleteFilesResult,
  type DownloadFileResult,
  type EffectiveConfig,
  type HostCapacity,
  type ListFilesOptions,
  type ListFilesResult,
  type NodeHealthResult,
  type NodeStatus,
  type ProviderCapabilities,
  type ReadFileResult,
  type RepairPlan,
  type RepairReport,
  type ResourceLimits,
  type UploadFileItem,
  type UploadFilesResult,
  type VirtualizationProvider,
  type WriteFileResult,
} from "./provider.js";

export interface RemoteProviderOptions {
  nodeId: string;
  baseUrl: string;
  authToken: string;
  tlsSkipVerify?: boolean;
  cfClientId?: string | null;
  cfClientSecret?: string | null;
}

export class RemoteAgentProvider implements VirtualizationProvider {
  readonly kind = "remote-agent";
  readonly capabilities: ProviderCapabilities = {
    create: true,
    start: true,
    stop: true,
    remove: true,
    liveStatus: true,
    files: true,
    console: true,
    metrics: true,
    repair: true,
    storageLimits: true,
  };

  private readonly nodeId: string;
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly tlsSkipVerify: boolean;
  private readonly cfClientId: string | null;
  private readonly cfClientSecret: string | null;
  private readonly agent: https.Agent | http.Agent;

  constructor(opts: RemoteProviderOptions) {
    this.nodeId = opts.nodeId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.authToken = opts.authToken;
    this.tlsSkipVerify = Boolean(opts.tlsSkipVerify);
    this.cfClientId = opts.cfClientId ?? null;
    this.cfClientSecret = opts.cfClientSecret ?? null;

    const isHttps = this.baseUrl.startsWith("https://");
    if (isHttps) {
      this.agent = new https.Agent({
        rejectUnauthorized: !this.tlsSkipVerify,
        keepAlive: true,
      });
    } else {
      this.agent = new http.Agent({ keepAlive: true });
    }
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...extra,
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    if (this.cfClientId && this.cfClientSecret) {
      headers["CF-Access-Client-Id"] = this.cfClientId;
      headers["CF-Access-Client-Secret"] = this.cfClientSecret;
    }
    return headers;
  }

  private request<T = any>(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: unknown,
    timeoutMs = 15000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const targetUrl = new URL(`${this.baseUrl}${path}`);
      const isHttps = targetUrl.protocol === "https:";
      const client = isHttps ? https : http;

      const bodyData = body !== undefined ? JSON.stringify(body) : undefined;
      const headers = this.buildHeaders(
        bodyData ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(bodyData)) } : {}
      );

      const req = client.request(
        targetUrl,
        {
          method,
          headers,
          agent: this.agent,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = {};
            if (raw.trim()) {
              try {
                parsed = JSON.parse(raw);
              } catch {
                parsed = { error: { message: raw } };
              }
            }

            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve((parsed.data !== undefined ? parsed.data : parsed) as T);
              return;
            }

            // Map errors
            const status = res.statusCode || 502;
            const errCode = parsed.error?.code || (status === 401 ? "AGENT_AUTH_FAILED" : "REMOTE_AGENT_ERROR");
            const errMsg = parsed.error?.message || `Remote agent returned HTTP ${status}.`;
            reject(new ProviderError(errCode, errMsg, status, parsed.error?.details));
          });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new ProviderError("NODE_TIMEOUT", `Request to remote node timed out after ${timeoutMs}ms.`, 504));
      });

      req.on("error", (err: any) => {
        if (err.code === "CERT_HAS_EXPIRED" || err.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
          reject(
            new ProviderError(
              "TLS_VERIFICATION_FAILED",
              `TLS certificate verification failed for remote node: ${err.message}. If using self-signed certs, enable TLS bypass for this node.`,
              502
            )
          );
          return;
        }
        if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "EHOSTUNREACH") {
          reject(new ProviderError("NODE_UNREACHABLE", `Failed to connect to remote node agent at ${this.baseUrl}: ${err.message}.`, 502));
          return;
        }
        reject(new ProviderError("NODE_CONNECTION_ERROR", `Remote node agent connection error: ${err.message}.`, 502));
      });

      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    });
  }

  async getNodeStatus(nodeId: string): Promise<NodeStatus> {
    try {
      const health = await this.getNodeHealth(nodeId);
      const host = health.host as any;
      return {
        nodeId,
        reachable: health.ok,
        detail: health.detail,
        containersTotal: health.containersTotal ?? 0,
        containersRunning: health.containersRunning ?? 0,
        cpuPercent: host?.cpuPercent ?? undefined,
        memoryUsedMb: host?.memoryUsedMb ?? undefined,
        memoryTotalMb: host?.memoryTotalMb ?? undefined,
        storageUsedGb: host?.rootUsedGb ?? undefined,
        storageTotalGb: host?.rootTotalGb ?? undefined,
        checkedAt: health.checkedAt,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("NODE_UNREACHABLE", "Host agent did not respond.");
    }
  }

  async getNodeHealth(nodeId: string): Promise<NodeHealthResult> {
    return this.request<NodeHealthResult>("/v1/health", "GET", undefined, 10000);
  }

  async listContainers(_nodeId: string): Promise<ContainerInfo[]> {
    const res = await this.request<{ containers: ContainerInfo[] }>("/v1/containers", "GET");
    return res.containers || [];
  }

  async getContainer(nodeId: string, containerId: string): Promise<ContainerInfo> {
    return this.request<ContainerInfo>(`/v1/containers/${encodeURIComponent(containerId)}`, "GET");
  }

  async getHostCapacity(_nodeId: string): Promise<HostCapacity> {
    return this.request<HostCapacity>("/v1/host/capacity", "GET");
  }

  async getSupportedTemplates(_nodeId: string): Promise<string[]> {
    const res = await this.request<{ templates: string[] }>("/v1/host/templates", "GET");
    return res.templates || [];
  }

  async createContainer(nodeId: string, request: CreateContainerRequest): Promise<ContainerInfo> {
    return this.request<ContainerInfo>("/v1/containers", "POST", request, 10 * 60 * 1000);
  }

  async startContainer(nodeId: string, containerId: string): Promise<void> {
    await this.request(`/v1/containers/${encodeURIComponent(containerId)}/start`, "POST", {}, 60000);
  }

  async stopContainer(nodeId: string, containerId: string): Promise<void> {
    await this.request(`/v1/containers/${encodeURIComponent(containerId)}/stop`, "POST", {}, 120000);
  }

  async deleteContainer(nodeId: string, containerId: string): Promise<void> {
    await this.request(`/v1/containers/${encodeURIComponent(containerId)}`, "DELETE", {}, 120000);
  }

  async containerExists(nodeId: string, containerId: string): Promise<boolean> {
    try {
      const res = await this.request<{ exists: boolean }>(`/v1/containers/${encodeURIComponent(containerId)}/state`, "GET");
      return res.exists;
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 404 || err.code === "CONTAINER_NOT_FOUND")) {
        return false;
      }
      throw err;
    }
  }

  async readContainerState(nodeId: string, containerId: string): Promise<string> {
    try {
      const res = await this.request<{ exists: boolean; status: string; rawState?: string }>(
        `/v1/containers/${encodeURIComponent(containerId)}/state`,
        "GET"
      );
      if (!res.exists) return "UNKNOWN";
      return (res.rawState || res.status || "UNKNOWN").toUpperCase();
    } catch {
      return "UNKNOWN";
    }
  }

  async getContainerNetwork(nodeId: string, containerId: string): Promise<ContainerNetworkInfo> {
    return this.request<ContainerNetworkInfo>(`/v1/containers/${encodeURIComponent(containerId)}/network`, "GET");
  }

  async getContainerMetrics(nodeId: string, containerId: string): Promise<ContainerMetrics> {
    return this.request<ContainerMetrics>(`/v1/containers/${encodeURIComponent(containerId)}/metrics`, "GET");
  }

  async getContainerStorage(nodeId: string, containerId: string): Promise<ContainerStorageInfo> {
    return this.request<ContainerStorageInfo>(`/v1/containers/${encodeURIComponent(containerId)}/storage`, "GET");
  }

  async readEffectiveConfig(nodeId: string, containerId: string): Promise<EffectiveConfig> {
    return this.request<EffectiveConfig>(`/v1/containers/${encodeURIComponent(containerId)}/config`, "GET");
  }

  async applyResourceLimits(nodeId: string, containerId: string, limits: ResourceLimits): Promise<EffectiveConfig> {
    return this.request<EffectiveConfig>(`/v1/containers/${encodeURIComponent(containerId)}/config`, "POST", limits);
  }

  async planRepair(nodeId: string, containerId: string, target: ResourceLimits): Promise<RepairPlan> {
    const q = new URLSearchParams();
    if (target.cpu) q.set("cpu", String(target.cpu));
    if (target.memoryMb) q.set("memoryMb", String(target.memoryMb));
    if (target.storageGb) q.set("storageGb", String(target.storageGb));
    const res = await this.request<{ plan: RepairPlan }>(`/v1/containers/${encodeURIComponent(containerId)}/repair?${q}`, "GET");
    return res.plan;
  }

  async applyRepair(nodeId: string, containerId: string, target: ResourceLimits): Promise<RepairReport> {
    const res = await this.request<{ report: RepairReport }>(`/v1/containers/${encodeURIComponent(containerId)}/repair`, "POST", target);
    return res.report;
  }

  async checkConsole(nodeId: string, containerId: string, template?: string): Promise<ConsoleCheck> {
    const q = template ? `?template=${encodeURIComponent(template)}` : "";
    return this.request<ConsoleCheck>(`/v1/containers/${encodeURIComponent(containerId)}/console/check${q}`, "GET");
  }

  openConsole(nodeId: string, containerId: string, clientWs: WebSocket, user: AuthUser, template?: string): void {
    const wsUrl = new URL(this.baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = `/v1/containers/${encodeURIComponent(containerId)}/console`;
    if (template) wsUrl.searchParams.set("template", template);

    const headers = this.buildHeaders();
    const agentWs = new WebSocket(wsUrl.toString(), {
      agent: this.agent,
      headers,
    });

    agentWs.on("open", () => {
      // Pipe client to agent
      clientWs.on("message", (msg) => {
        if (agentWs.readyState === WebSocket.OPEN) {
          agentWs.send(msg);
        }
      });
    });

    // Pipe agent to client
    agentWs.on("message", (msg) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msg);
      }
    });

    agentWs.on("close", (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason);
      }
    });

    agentWs.on("error", (err) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "error", message: `Agent websocket error: ${err.message}` }));
        clientWs.close(4502, "Agent connection error.");
      }
    });

    clientWs.on("close", () => {
      if (agentWs.readyState === WebSocket.OPEN || agentWs.readyState === WebSocket.CONNECTING) {
        agentWs.close();
      }
    });
  }

  async listFiles(nodeId: string, containerId: string, userPath: string, opts: ListFilesOptions = {}): Promise<ListFilesResult> {
    const q = new URLSearchParams();
    q.set("path", userPath);
    if (opts.q) q.set("search", opts.q);
    if (opts.sort) q.set("sort", opts.sort);
    if (opts.order) q.set("order", opts.order);
    if (opts.limit) q.set("pageSize", String(opts.limit));
    if (opts.offset) q.set("page", String(Math.floor(opts.offset / (opts.limit || 100)) + 1));

    const res = await this.request<{
      path: string;
      entries: any[];
      total: number;
      page: number;
      pageSize: number;
    }>(`/v1/containers/${encodeURIComponent(containerId)}/files?${q}`, "GET");

    return {
      path: res.path,
      entries: (res.entries || []).map((e) => ({
        name: e.name,
        path: e.path,
        type: e.type === "directory" ? "dir" : e.type,
        size: e.size,
        children: null,
        mode: "-rw-r--r--",
        mtime: e.modified || new Date().toISOString(),
        target: null,
      })),
      pagination: {
        limit: res.pageSize || 100,
        offset: ((res.page || 1) - 1) * (res.pageSize || 100),
        total: res.total || 0,
      },
    };
  }

  async readFile(nodeId: string, containerId: string, userPath: string): Promise<ReadFileResult> {
    const q = new URLSearchParams({ path: userPath });
    const res = await this.request<{ content: string; hash: string; size: number }>(
      `/v1/containers/${encodeURIComponent(containerId)}/files/content?${q}`,
      "GET"
    );
    return {
      content: res.content,
      hash: res.hash,
      size: res.size,
      mtime: new Date().toISOString(),
    };
  }

  async writeFile(
    nodeId: string,
    containerId: string,
    userPath: string,
    content: string,
    expectedHash?: string
  ): Promise<WriteFileResult> {
    const res = await this.request<{ bytesWritten: number; hash: string }>(
      `/v1/containers/${encodeURIComponent(containerId)}/files/content`,
      "PUT",
      { path: userPath, content, expectedHash }
    );
    return {
      size: res.bytesWritten,
      hash: res.hash,
      mtime: new Date().toISOString(),
    };
  }

  async createFileEntry(
    nodeId: string,
    containerId: string,
    userPath: string,
    type: "file" | "dir"
  ): Promise<{ path: string; type: "file" | "dir" }> {
    await this.request(
      `/v1/containers/${encodeURIComponent(containerId)}/files`,
      "POST",
      { path: userPath, type: type === "dir" ? "directory" : "file" }
    );
    return { path: userPath, type };
  }

  async moveFileEntry(nodeId: string, containerId: string, srcPath: string, dstPath: string): Promise<{ from: string; to: string }> {
    await this.request(
      `/v1/containers/${encodeURIComponent(containerId)}/files/move`,
      "POST",
      { source: srcPath, destination: dstPath }
    );
    return { from: srcPath, to: dstPath };
  }

  async deleteFileEntries(nodeId: string, containerId: string, paths: string[]): Promise<DeleteFilesResult> {
    const res = await this.request<{ deleted: string[] }>(
      `/v1/containers/${encodeURIComponent(containerId)}/files`,
      "DELETE",
      { paths }
    );
    return { deleted: res.deleted || [], count: (res.deleted || []).length };
  }

  async uploadFiles(
    nodeId: string,
    containerId: string,
    dirPath: string,
    files: any,
    overwrite?: boolean
  ): Promise<UploadFilesResult> {
    const list = Array.isArray(files) ? files : [];
    const payload = list.map((f: any) => {
      const relName = f.name || f.path || "file";
      const fullPath = relName.startsWith("/") ? relName : `${dirPath.replace(/\/+$/, "")}/${relName}`;
      const content = Buffer.isBuffer(f.content)
        ? f.content.toString("base64")
        : typeof f.content === "string"
        ? f.content
        : "";
      return {
        path: fullPath,
        contentBase64: content,
        overwrite: f.overwrite ?? overwrite,
      };
    });
    const res = await this.request<{ uploaded: { path: string; size: number }[] }>(
      `/v1/containers/${encodeURIComponent(containerId)}/files/upload`,
      "POST",
      { files: payload }
    );
    const uploadedList = res.uploaded || [];
    const written = uploadedList.map((u) => u.path);
    const bytes = uploadedList.reduce((acc, u) => acc + (u.size || 0), 0);
    return {
      path: dirPath,
      written,
      bytes,
      files: uploadedList.map((u) => ({
        name: u.path.split("/").pop() || u.path,
        path: u.path,
        size: u.size,
        mtime: new Date().toISOString(),
        overwritten: Boolean(overwrite),
      })),
    };
  }

  async downloadFile(nodeId: string, containerId: string, userPath: string): Promise<DownloadFileResult> {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ path: userPath });
      const targetUrl = new URL(`${this.baseUrl}/v1/containers/${encodeURIComponent(containerId)}/files/download?${q}`);
      const isHttps = targetUrl.protocol === "https:";
      const client = isHttps ? https : http;

      const req = client.get(
        targetUrl,
        {
          headers: this.buildHeaders(),
          agent: this.agent,
          timeout: 30000,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            const size = parseInt(res.headers["content-length"] || "0", 10);
            const disp = res.headers["content-disposition"] || "";
            const match = /filename="([^"]+)"/.exec(disp);
            const filename = match ? match[1] : "download";
            resolve({
              stream: res,
              filename,
              size,
              mtime: new Date().toISOString(),
            });
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = {};
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { error: { message: raw } };
            }
            reject(new ProviderError(parsed.error?.code || "DOWNLOAD_FAILED", parsed.error?.message || "File download failed.", res.statusCode || 502));
          });
        }
      );

      req.on("error", (err) => {
        reject(new ProviderError("DOWNLOAD_ERROR", `Failed to download file from agent: ${err.message}`, 502));
      });
    });
  }
}
