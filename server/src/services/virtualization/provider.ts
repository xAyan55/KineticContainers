import type { WebSocket } from "ws";
import type { AuthUser } from "../../middleware/auth.js";

export type ContainerStatus =
  | "running"
  | "stopped"
  | "starting"
  | "stopping"
  | "failed"
  | "unknown";

export interface NodeStatus {
  nodeId: string;
  reachable: boolean;
  detail: string;
  containersTotal?: number;
  containersRunning?: number;
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  storageUsedGb?: number;
  storageTotalGb?: number;
  checkedAt: string;
}

export interface ContainerInfo {
  containerId: string;
  name: string;
  status: ContainerStatus;
  ipv4?: string;
  cpu?: number;
  memoryMb?: number;
}

export interface CreateContainerRequest {
  name: string;
  containerId?: string;
  template: string;
  cpu: number;
  memoryMb: number;
  storageGb: number;
  network?: string;
}

export interface ProviderCapabilities {
  readonly create: boolean;
  readonly start: boolean;
  readonly stop: boolean;
  readonly remove: boolean;
  readonly liveStatus: boolean;
  readonly files: boolean;
  readonly console: boolean;
  readonly metrics: boolean;
  readonly repair: boolean;
  readonly storageLimits: boolean;
}

export interface ContainerNetworkInterface {
  name: string;
  hwaddr: string;
  inet?: string;
}

export interface ContainerNetworkInfo {
  interfaces?: ContainerNetworkInterface[];
  primaryIpv4?: string | null;
  state?: string;
  pid?: number | null;
  ipv4?: string[];
  ipv6?: string[];
  links?: string[];
  bridge?: string | null;
}

export interface ContainerMetrics {
  cpuSeconds: number | null;
  memoryMb: number | null;
  cpuPercent?: number | null;
  diskUsageGb?: number | null;
  sampledAt?: string;
}

export interface ContainerStorageInfo {
  backend: string;
  quotaSupported: boolean;
  quotaGb?: number | null;
  quotaEnforcedGb?: number | null;
  usedGb?: number | null;
  diskUsageGb?: number | null;
  rootfsPath?: string;
  note?: string;
}

export interface EffectiveConfig {
  cpu: number | null;
  memoryMb: number | null;
  cpuset?: string | null;
  cpusetCpus?: number | null;
  cpuModel?: string;
  storageGb?: null | number;
  storageEnforced?: boolean;
  storageNote?: string;
  cgroupVersion?: string;
  lxcfsActive?: boolean | null;
}

export interface ResourceLimits {
  cpu?: number;
  memoryMb?: number;
  storageGb?: number;
}

export interface ApplyLimitsResult {
  liveApplied: boolean;
  restartRequired: boolean;
  cgroupVersion: string;
}

export interface RepairCheck {
  check: string;
  status: "ok" | "fixed" | "failed" | "unsupported" | "needed" | "needs-fix";
  detail?: string;
  message?: string;
}

export interface RepairPlan {
  containerId: string;
  exists?: boolean;
  restartNeeded?: boolean;
  warnings?: string[];
  checks: Array<{ check: string; status: "ok" | "needed" | "unsupported" | "needs-fix"; detail?: string; message?: string }>;
}

export interface RepairReport {
  containerId: string;
  backupPath?: string | null;
  warnings?: string[];
  checks: Array<RepairCheck>;
  restartNeeded?: boolean;
}

export interface ConsoleCheck {
  supported: boolean;
  running: boolean;
  shell: string | null;
  reason: string | null;
}

export interface FileEntryItem {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  children: number | null;
  mode: string;
  mtime: string;
  target: string | null;
}

export interface ListFilesOptions {
  limit?: number;
  offset?: number;
  sort?: "name" | "size" | "type" | "mtime";
  order?: "asc" | "desc";
  q?: string;
}

export interface ListFilesResult {
  path: string;
  entries: FileEntryItem[];
  pagination: { limit: number; offset: number; total: number };
}

export interface ReadFileResult {
  path?: string;
  content: string;
  hash?: string;
  size: number;
  mtime: string;
}

export interface WriteFileResult {
  path?: string;
  size: number;
  hash?: string;
  mtime: string;
}

export interface DeleteFilesResult {
  deleted: string[];
  count?: number;
}

export interface UploadFileItem {
  path?: string;
  name?: string;
  content: Buffer | string;
  overwrite?: boolean;
}

export interface UploadFilesResult {
  path?: string;
  files?: Array<{ name: string; path: string; size: number; mtime: string; overwritten: boolean }>;
  written?: string[];
  bytes?: number;
}

export interface DownloadFileResult {
  stream: NodeJS.ReadableStream;
  filename: string;
  size: number;
  mtime?: string;
}

export interface HostCapacity {
  memoryAvailableMb?: number;
  storageAvailableGb?: number;
  cpuCount?: number;
  memoryTotalMb?: number;
  memoryFreeMb?: number;
  diskAvailGb?: number | null;
}

export interface NodeHealthResult {
  status: string;
  ok: boolean;
  checkedAt: string;
  detail: string;
  checks: {
    lxcInstalled: boolean;
    commandsOk: boolean;
    permissionsOk: boolean;
    inventoryOk: boolean;
    resourcesOk: boolean;
  };
  host: Record<string, unknown> | null;
  hostCapabilities: Record<string, unknown> | null;
  containersTotal: number | null;
  containersRunning: number | null;
}

/**
 * Provider abstraction so alternative infrastructure backends can be
 * added without rewriting business logic. Only expose operations the
 * active integration genuinely supports (see `capabilities`).
 */
export interface VirtualizationProvider {
  readonly kind: string;
  readonly capabilities: ProviderCapabilities;

  // Node health & inventory
  getNodeStatus(nodeId: string): Promise<NodeStatus>;
  getNodeHealth(nodeId: string): Promise<NodeHealthResult>;
  listContainers(nodeId: string): Promise<ContainerInfo[]>;
  getContainer(nodeId: string, containerId: string): Promise<ContainerInfo>;

  // Host capacity & templates
  getHostCapacity(nodeId: string): Promise<HostCapacity>;
  getSupportedTemplates(nodeId: string): Promise<string[]>;

  // Lifecycle
  createContainer(nodeId: string, request: CreateContainerRequest): Promise<ContainerInfo>;
  startContainer(nodeId: string, containerId: string): Promise<void>;
  stopContainer(nodeId: string, containerId: string): Promise<void>;
  deleteContainer(nodeId: string, containerId: string): Promise<void>;
  containerExists(nodeId: string, containerId: string): Promise<boolean>;
  readContainerState(nodeId: string, containerId: string): Promise<string>;

  // Config, metrics, network, storage
  getContainerNetwork(nodeId: string, containerId: string): Promise<ContainerNetworkInfo>;
  getContainerMetrics(nodeId: string, containerId: string): Promise<ContainerMetrics>;
  getContainerStorage(nodeId: string, containerId: string): Promise<ContainerStorageInfo>;
  readEffectiveConfig(nodeId: string, containerId: string): Promise<EffectiveConfig>;
  applyResourceLimits(nodeId: string, containerId: string, limits: ResourceLimits): Promise<ApplyLimitsResult | EffectiveConfig>;

  // Repair
  planRepair(nodeId: string, containerId: string, target: { cpu: number; memoryMb: number; storageGb: number }): Promise<RepairPlan>;
  applyRepair(nodeId: string, containerId: string, target: { cpu: number; memoryMb: number; storageGb: number }): Promise<RepairReport>;

  // Console
  checkConsole(nodeId: string, containerId: string, template?: string): Promise<ConsoleCheck>;
  openConsole(nodeId: string, containerId: string, clientWs: WebSocket, user: AuthUser, template?: string): void;

  // Files
  listFiles(nodeId: string, containerId: string, path: string, opts?: ListFilesOptions): Promise<ListFilesResult>;
  readFile(nodeId: string, containerId: string, path: string): Promise<ReadFileResult>;
  writeFile(nodeId: string, containerId: string, path: string, content: string, expectedMtime?: unknown): Promise<WriteFileResult>;
  createFileEntry(nodeId: string, containerId: string, path: string, type: "file" | "dir"): Promise<{ entry?: FileEntryItem; path?: string; type?: string }>;
  moveFileEntry(nodeId: string, containerId: string, srcPath: string, dstPath: string): Promise<{ from: string; to: string }>;
  deleteFileEntries(nodeId: string, containerId: string, paths: string[]): Promise<DeleteFilesResult>;
  uploadFiles(nodeId: string, containerId: string, dirPath: string, files: any, overwrite?: boolean): Promise<UploadFilesResult>;
  downloadFile(nodeId: string, containerId: string, path: string): Promise<DownloadFileResult>;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status = 502, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export { getProviderForNode } from "./providerRegistry.js";
