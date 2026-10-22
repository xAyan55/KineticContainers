import { getDb } from "../../db.js";
import { decryptSecret } from "../crypto.js";
import {
  ProviderError,
  type VirtualizationProvider,
  type NodeStatus,
  type NodeHealthResult,
  type ContainerInfo,
  type HostCapacity,
  type CreateContainerRequest,
  type ContainerNetworkInfo,
  type ContainerMetrics,
  type ContainerStorageInfo,
  type EffectiveConfig,
  type ResourceLimits,
  type RepairPlan,
  type RepairReport,
  type ConsoleCheck,
  type ListFilesOptions,
  type ListFilesResult,
  type ReadFileResult,
  type WriteFileResult,
  type DeleteFilesResult,
  type UploadFileItem,
  type UploadFilesResult,
  type DownloadFileResult,
  type ProviderCapabilities,
} from "./provider.js";
import { LocalLxcProvider, UnconfiguredProvider } from "./localAgent.js";
import { RemoteAgentProvider } from "./remoteProvider.js";

export class UnconfiguredRemoteProvider implements VirtualizationProvider {
  readonly kind = "remote-unconfigured";
  readonly capabilities: ProviderCapabilities = {
    create: false,
    start: false,
    stop: false,
    remove: false,
    liveStatus: false,
    files: false,
    console: false,
    metrics: false,
    repair: false,
    storageLimits: false,
  };

  private readonly detail: string;

  constructor(detail = "Remote node is not configured or enrolled yet.") {
    this.detail = detail;
  }

  private err(): ProviderError {
    return new ProviderError("REMOTE_NODE_UNSUPPORTED", this.detail, 409);
  }

  getNodeStatus(): Promise<NodeStatus> {
    throw this.err();
  }
  getNodeHealth(nodeId: string): Promise<NodeHealthResult> {
    return Promise.resolve({
      status: "unavailable",
      ok: false,
      checkedAt: new Date().toISOString(),
      detail: this.detail,
      checks: { lxcInstalled: false, commandsOk: false, permissionsOk: false, inventoryOk: false, resourcesOk: false },
      host: null,
      hostCapabilities: null,
      containersTotal: null,
      containersRunning: null,
    });
  }
  listContainers(): Promise<ContainerInfo[]> {
    throw this.err();
  }
  getContainer(): Promise<ContainerInfo> {
    throw this.err();
  }
  getHostCapacity(): Promise<HostCapacity> {
    throw this.err();
  }
  getSupportedTemplates(): Promise<string[]> {
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
  containerExists(): Promise<boolean> {
    throw this.err();
  }
  readContainerState(): Promise<string> {
    throw this.err();
  }
  getContainerNetwork(): Promise<ContainerNetworkInfo> {
    throw this.err();
  }
  getContainerMetrics(): Promise<ContainerMetrics> {
    throw this.err();
  }
  getContainerStorage(): Promise<ContainerStorageInfo> {
    throw this.err();
  }
  readEffectiveConfig(): Promise<EffectiveConfig> {
    throw this.err();
  }
  applyResourceLimits(): Promise<EffectiveConfig> {
    throw this.err();
  }
  planRepair(): Promise<RepairPlan> {
    throw this.err();
  }
  applyRepair(): Promise<RepairReport> {
    throw this.err();
  }
  checkConsole(): Promise<ConsoleCheck> {
    throw this.err();
  }
  openConsole(): void {
    throw this.err();
  }
  listFiles(): Promise<ListFilesResult> {
    throw this.err();
  }
  readFile(): Promise<ReadFileResult> {
    throw this.err();
  }
  writeFile(): Promise<WriteFileResult> {
    throw this.err();
  }
  createFileEntry(): Promise<{ path: string; type: "file" | "dir" }> {
    throw this.err();
  }
  moveFileEntry(): Promise<{ from: string; to: string }> {
    throw this.err();
  }
  deleteFileEntries(): Promise<DeleteFilesResult> {
    throw this.err();
  }
  uploadFiles(): Promise<UploadFilesResult> {
    throw this.err();
  }
  downloadFile(): Promise<DownloadFileResult> {
    throw this.err();
  }
}

/**
 * Node-aware virtualization provider resolution.
 * Resolves the authoritative registered node and selects either LocalLxcProvider
 * or RemoteAgentProvider. Never performs an operation on the Local Node when
 * the instance belongs to a remote node.
 */
export function getProviderForNode(nodeId: string): VirtualizationProvider {
  if (!nodeId) {
    throw new ProviderError("NODE_NOT_FOUND", "Node ID is required.", 404);
  }

  const db = getDb();
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as
    | Record<string, unknown>
    | undefined;

  if (!node) {
    throw new ProviderError("NODE_NOT_FOUND", `Virtualization node "${nodeId}" is not registered.`, 404);
  }

  if (node.endpoint === "local" || node.id === "local") {
    return new LocalLxcProvider();
  }

  // Remote node
  const endpoint = String(node.endpoint || "").trim();
  const rawCred = (node.auth_credential || node.api_token) as string | null | undefined;
  const authToken = decryptSecret(rawCred);

  // If node is unconfigured or has no token/invalid endpoint, return honest unconfigured provider
  if (!authToken || node.status === "unconfigured" || !endpoint.startsWith("http")) {
    return new UnconfiguredRemoteProvider(
      (node.last_error as string) || "Remote node agent is not configured or enrolled yet."
    );
  }

  const cfClientSecret = decryptSecret(node.cf_client_secret as string | null | undefined);

  return new RemoteAgentProvider({
    nodeId: String(node.id),
    baseUrl: endpoint,
    authToken,
    tlsSkipVerify: Number(node.tls_skip_verify || 0) === 1,
    cfClientId: (node.cf_client_id as string) || null,
    cfClientSecret: cfClientSecret || null,
  });
}
