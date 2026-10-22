export type ContainerStatus =
  | "running"
  | "stopped"
  | "starting"
  | "stopping"
  | "failed"
  | "unknown";

export interface AgentCapabilities {
  create: boolean;
  start: boolean;
  stop: boolean;
  restart: boolean;
  remove: boolean;
  liveStatus: boolean;
  files: boolean;
  console: boolean;
  metrics: boolean;
  repair: boolean;
  quotas: {
    btrfs: boolean;
    ext4: boolean;
  };
}

export interface AgentIdentity {
  nodeId: string;
  agentVersion: string;
  apiVersions: string[];
  capabilities: AgentCapabilities;
  hostname: string;
  platform: string;
  arch: string;
}

export interface HostInfo {
  hostname: string;
  platform: string;
  osName: string | null;
  osVersion: string | null;
  kernel: string;
  arch: string;
  memoryTotalMb: number;
  memoryFreeMb: number;
  memoryUsedMb: number;
  cpuModel: string | null;
  cpuCount: number;
  cpuPercent: number | null;
  load1: number | null;
  rootTotalGb: number | null;
  rootUsedGb: number | null;
  rootAvailGb: number | null;
}

export interface HostCapabilities {
  lxcInstalled: boolean;
  lxcVersion: string | null;
  nestedGuest: string | null;
  restrictedGuest: boolean;
  userNamespaces: boolean | null;
  cgroup: "v1" | "v2" | "hybrid" | "none";
  bridgePresent: boolean | null;
  ipForwarding: boolean | null;
  runtimeUid: number | null;
  lxcfsActive: boolean;
}

export interface NodeHealthCheck {
  status: "online" | "unconfigured" | "error" | "unavailable";
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
  host: HostInfo | null;
  hostCapabilities: HostCapabilities | null;
  containersTotal: number | null;
  containersRunning: number | null;
}

export interface ContainerInfo {
  containerId: string;
  name: string;
  status: ContainerStatus;
  ipv4?: string;
  cpu?: number;
  memoryMb?: number;
  diskUsageGb?: number;
}

export interface CreateContainerRequest {
  name: string;
  template: string;
  cpu: number;
  memoryMb: number;
  storageGb: number;
  containerId?: string;
  network?: string;
}

export interface ResourceLimits {
  cpu: number;
  memoryMb: number;
  storageGb?: number;
}

export interface EffectiveConfig {
  cpuLimit: number | null;
  memoryMb: number | null;
  lxcfsActive: boolean | null;
  cgroupVersion: string;
  storageBackend?: string;
  storageQuotaGb?: number | null;
}

export interface ContainerMetrics {
  cpuSeconds: number | null;
  cpuPercent: number | null;
  memoryMb: number | null;
  memoryLimitMb: number | null;
  diskUsageGb: number | null;
  sampledAt: string;
}

export interface ContainerNetworkInterface {
  name: string;
  hwaddr: string;
  inet?: string;
}

export interface ContainerNetworkInfo {
  interfaces: ContainerNetworkInterface[];
  primaryIpv4: string | null;
}

export interface ContainerStorageInfo {
  backend: string;
  quotaSupported: boolean;
  quotaEnforcedGb: number | null;
  diskUsageGb: number | null;
  rootfsPath: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: string;
  mode?: number;
}

export interface ListFilesQuery {
  path?: string;
  search?: string;
  sort?: "name" | "size" | "modified";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface ListFilesResult {
  path: string;
  entries: FileEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  size: number;
  hash: string;
  isText: boolean;
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
  hash: string;
}

export interface UploadFilePayload {
  path: string;
  contentBase64: string;
}

export interface UploadFilesResult {
  uploaded: { path: string; size: number }[];
}

export interface DeleteFilesResult {
  deleted: string[];
}

export interface RepairCheck {
  check: string;
  status: "ok" | "fixed" | "failed" | "unsupported";
  message: string;
}

export interface RepairPlan {
  containerId: string;
  checks: { check: string; status: "ok" | "needed" | "unsupported"; detail: string }[];
}

export interface RepairReport {
  containerId: string;
  checks: RepairCheck[];
}

export interface ConsoleCheck {
  supported: boolean;
  running: boolean;
  shell: string | null;
  reason: string | null;
}
