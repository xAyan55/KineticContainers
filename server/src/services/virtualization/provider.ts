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

/**
 * Provider abstraction so alternative infrastructure backends can be
 * added without rewriting business logic. Only expose operations the
 * active integration genuinely supports (see `capabilities`).
 */
export interface VirtualizationProvider {
  readonly kind: string;
  readonly capabilities: {
    create: boolean;
    start: boolean;
    stop: boolean;
    remove: boolean;
    liveStatus: boolean;
  };
  getNodeStatus(nodeId: string): Promise<NodeStatus>;
  listContainers(nodeId: string): Promise<ContainerInfo[]>;
  getContainer(nodeId: string, containerId: string): Promise<ContainerInfo>;
  createContainer(nodeId: string, request: CreateContainerRequest): Promise<ContainerInfo>;
  startContainer(nodeId: string, containerId: string): Promise<void>;
  stopContainer(nodeId: string, containerId: string): Promise<void>;
  deleteContainer(nodeId: string, containerId: string): Promise<void>;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
