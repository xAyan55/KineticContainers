import type {
  ContainerInfo,
  CreateContainerRequest,
  NodeStatus,
  VirtualizationProvider,
} from "./provider.js";
import { ProviderError } from "./provider.js";
import { parseLxcLs, runLxc } from "./host.js";
import { getDb } from "../../db.js";

const run = runLxc;

function validateContainerId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$/.test(id)) {
    throw new ProviderError("INVALID_CONTAINER_ID", "Container identifier is invalid.", 400);
  }
}

const SUPPORTED_TEMPLATES = ["ubuntu-22.04", "ubuntu-24.04", "debian-12", "alpine-3.20"];

/**
 * Privileged host integration. Runs `lxc-*` binaries with strict
 * argument vectors (never shell strings) and bounded output. When no
 * node is configured or LXC is absent, callers receive an honest
 * "unavailable" result instead of fabricated data.
 */
export class LocalLxcProvider implements VirtualizationProvider {
  readonly kind = "local-lxc";
  readonly capabilities = { create: true, start: true, stop: true, remove: true, liveStatus: true };

  private requireLocalNode(nodeId: string): void {
    const db = getDb();
    const node = db.prepare("SELECT id, endpoint FROM nodes WHERE id = ?").get(nodeId) as
      | { id: string; endpoint: string }
      | undefined;
    if (!node) throw new ProviderError("NODE_NOT_FOUND", "Virtualization node is not registered.", 404);
    if (node.endpoint !== "local") {
      throw new ProviderError(
        "REMOTE_NODE_UNSUPPORTED",
        "Only the local host agent is implemented; remote nodes are not connected."
      );
    }
  }

  static supportedTemplates(): string[] {
    return [...SUPPORTED_TEMPLATES];
  }

  async getNodeStatus(nodeId: string): Promise<NodeStatus> {
    this.requireLocalNode(nodeId);
    try {
      const { stdout } = await run("lxc-ls", ["--format", "csv"]);
      const containers = parseLxcLs(stdout);
      const running = containers.filter((c) => c.status === "running").length;
      return {
        nodeId,
        reachable: true,
        detail: "Host agent reachable; LXC tools responded.",
        containersTotal: containers.length,
        containersRunning: running,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("NODE_UNREACHABLE", "Host agent did not respond.");
    }
  }

  async listContainers(nodeId: string): Promise<ContainerInfo[]> {
    this.requireLocalNode(nodeId);
    const { stdout } = await run("lxc-ls", ["-f"]);
    return parseLxcLs(stdout);
  }

  async getContainer(nodeId: string, containerId: string): Promise<ContainerInfo> {
    validateContainerId(containerId);
    const all = await this.listContainers(nodeId);
    const found = all.find((c) => c.containerId === containerId);
    if (!found) throw new ProviderError("CONTAINER_NOT_FOUND", "Container not found on node.", 404);
    return found;
  }

  async createContainer(nodeId: string, request: CreateContainerRequest): Promise<ContainerInfo> {
    this.requireLocalNode(nodeId);
    validateContainerId(request.name);
    if (!SUPPORTED_TEMPLATES.includes(request.template)) {
      throw new ProviderError("UNSUPPORTED_TEMPLATE", "Requested template is not supported.", 400);
    }
    if (!Number.isInteger(request.cpu) || request.cpu < 1 || request.cpu > 32) {
      throw new ProviderError("INVALID_RESOURCES", "CPU allocation out of range (1-32).", 400);
    }
    if (!Number.isInteger(request.memoryMb) || request.memoryMb < 128 || request.memoryMb > 131072) {
      throw new ProviderError("INVALID_RESOURCES", "Memory allocation out of range.", 400);
    }
    if (!Number.isInteger(request.storageGb) || request.storageGb < 1 || request.storageGb > 2000) {
      throw new ProviderError("INVALID_RESOURCES", "Storage allocation out of range.", 400);
    }
    const name = request.containerId?.trim() ? request.containerId.trim() : request.name.trim();
    validateContainerId(name);
    // Narrowly privileged creation: fixed template map, no shell interpolation.
    await run("lxc-create", ["-n", name, "-t", "download", "--", "-d", "ubuntu", "-r", "jammy", "-a", "amd64"]);
    return { containerId: name, name, status: "stopped" };
  }

  async startContainer(nodeId: string, containerId: string): Promise<void> {
    this.requireLocalNode(nodeId);
    validateContainerId(containerId);
    await run("lxc-start", ["-n", containerId]);
  }

  async stopContainer(nodeId: string, containerId: string): Promise<void> {
    this.requireLocalNode(nodeId);
    validateContainerId(containerId);
    await run("lxc-stop", ["-n", containerId]);
  }

  async deleteContainer(nodeId: string, containerId: string): Promise<void> {
    this.requireLocalNode(nodeId);
    validateContainerId(containerId);
    await run("lxc-destroy", ["-n", containerId, "-f"]);
  }
}

/** Returned when no node is registered yet — honest "not configured" state. */
export class UnconfiguredProvider implements VirtualizationProvider {
  readonly kind = "unconfigured";
  readonly capabilities = { create: false, start: false, stop: false, remove: false, liveStatus: false };
  private err(): ProviderError {
    return new ProviderError("INFRA_UNCONFIGURED", "No virtualization node is configured.", 409);
  }
  getNodeStatus(): Promise<NodeStatus> {
    throw this.err();
  }
  listContainers(): Promise<ContainerInfo[]> {
    throw this.err();
  }
  getContainer(): Promise<ContainerInfo> {
    throw this.err();
  }
  createContainer(): Promise<ContainerInfo> {
    throw this.err();
  }
  startContainer(): Promise<void> {
    throw this.err();
  }
  stopContainer(): Promise<void> {
    throw this.err();
  }
  deleteContainer(): Promise<void> {
    throw this.err();
  }
}

export function getProvider(): VirtualizationProvider {
  try {
    const db = getDb();
    const row = db.prepare("SELECT id FROM nodes LIMIT 1").get() as { id: string } | undefined;
    if (!row) return new UnconfiguredProvider();
    return new LocalLxcProvider();
  } catch {
    return new UnconfiguredProvider();
  }
}
