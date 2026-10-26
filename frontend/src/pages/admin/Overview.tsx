import * as React from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Cpu,
  ExternalLink,
  HardDrive,
  KeyRound,
  Layers,
  Network,
  Plus,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  UserCheck,
  Users,
} from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button, Card, EmptyState, InlineAlert, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

interface Overview {
  users_total: number;
  containers_total: number;
  containers_running: number;
  containers_stopped: number;
  nodes_total: number;
  nodes: { id: string; name: string; endpoint: string; status: string; last_seen_at: string | null }[];
  utilization: Record<string, unknown> | null;
  infra_status: string;
  infra_configured: boolean;
  recent_events: {
    id: string;
    action: string;
    actor_id: string | null;
    target_type: string | null;
    target_id: string | null;
    created_at: string;
  }[];
  migration_version: number;
  app_version: string;
}

interface AdminInstanceShort {
  id: string;
  cpu: number;
  memory_mb: number;
  storage_gb: number;
  status: string;
}

function formatRelativeTime(iso?: string | null): string {
  if (!iso) return "never";
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    return `${diffDays}d ago`;
  } catch {
    return String(iso);
  }
}

function formatMemory(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

export function AdminOverviewPage(): React.JSX.Element {
  const [data, setData] = React.useState<Overview | null>(null);
  const [instances, setInstances] = React.useState<AdminInstanceShort[]>([]);
  const [error, setError] = React.useState<string | undefined>();
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState<Date>(new Date());

  const loadData = React.useCallback(async () => {
    try {
      const [ovRes, instRes] = await Promise.allSettled([
        api.get<Overview>("/api/admin/overview"),
        api.get<{ instances: AdminInstanceShort[] }>("/api/admin/instances?page_size=100"),
      ]);

      if (ovRes.status === "fulfilled") {
        setData(ovRes.value);
        setError(undefined);
      } else {
        const err = ovRes.reason;
        setError(err instanceof ApiError ? err.message : "Unable to load platform overview.");
      }

      if (instRes.status === "fulfilled" && instRes.value?.instances) {
        setInstances(instRes.value.instances);
      }
      setLastRefreshed(new Date());
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    void loadData();
  };

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Overview" />
        <InlineAlert message={error} />
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <PageHeader title="Overview" />
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <RefreshCw className="h-4 w-4 animate-spin text-muted" />
          <span>Loading platform telemetry…</span>
        </div>
      </div>
    );
  }

  // Aggregate genuine infrastructure resource figures
  const totalCpu = instances.reduce((acc, i) => acc + (i.cpu || 0), 0);
  const totalMemory = instances.reduce((acc, i) => acc + (i.memory_mb || 0), 0);
  const totalStorage = instances.reduce((acc, i) => acc + (i.storage_gb || 0), 0);

  const runningCount = data.containers_running;
  const stoppedCount = data.containers_stopped;
  const otherCount = Math.max(0, data.containers_total - (runningCount + stoppedCount));

  const totalContainers = Math.max(1, data.containers_total);
  const runningPercent = Math.round((runningCount / totalContainers) * 100);
  const stoppedPercent = Math.round((stoppedCount / totalContainers) * 100);
  const otherPercent = Math.max(0, 100 - (runningPercent + stoppedPercent));

  return (
    <div className="space-y-4">
      {/* Top Header & Refresh Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-primary">System Overview</h1>
          <p className="mt-0.5 text-xs text-muted">
            Live infrastructure telemetry, resource allocations, and audit trail from active records.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted font-mono hidden sm:inline">
            Synced {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Refresh platform overview"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-primary hover:border-highlight hover:bg-raised transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin text-muted")} />
            <span>Refresh</span>
          </button>
          <Link
            to="/admin/create"
            className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-black hover:bg-neutral-200 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Create VPS</span>
          </Link>
        </div>
      </div>

      {error ? <InlineAlert message={error} /> : null}

      {/* Bento Row 1: Key Metric Strips (4 Rectangular Tiles) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* Metric 1: Container Fleet */}
        <div className="kct-card kct-card-interactive flex flex-col justify-between p-3.5 sm:p-4">
          <div className="flex items-center justify-between text-muted">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">Managed Fleet</span>
            <Server className="h-4 w-4 text-muted" aria-hidden="true" />
          </div>
          <div className="mt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-primary font-mono">
                {data.containers_total}
              </span>
              <span className="text-xs text-muted">VPS containers</span>
            </div>
            {/* Visual ratio bar */}
            <div className="mt-2.5 flex h-1.5 w-full overflow-hidden rounded bg-mid">
              <div
                style={{ width: `${runningPercent}%` }}
                className="bg-emerald-500 transition-all duration-300"
                title={`${runningCount} running (${runningPercent}%)`}
              />
              <div
                style={{ width: `${otherPercent}%` }}
                className="bg-amber-500 transition-all duration-300"
                title={`${otherCount} suspended`}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted font-mono">
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {runningCount} active
              </span>
              <span>{stoppedCount} stopped</span>
            </div>
          </div>
        </div>

        {/* Metric 2: Compute Power */}
        <div className="kct-card kct-card-interactive flex flex-col justify-between p-3.5 sm:p-4">
          <div className="flex items-center justify-between text-muted">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">Allocated Compute</span>
            <Cpu className="h-4 w-4 text-muted" aria-hidden="true" />
          </div>
          <div className="mt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-primary font-mono">
                {totalCpu}
              </span>
              <span className="text-xs text-muted">vCPU cores</span>
            </div>
            <p className="mt-2 text-xs text-muted">
              Provisioned across {instances.length} fleet {instances.length === 1 ? "container" : "containers"}
            </p>
          </div>
        </div>

        {/* Metric 3: Memory Allocation */}
        <div className="kct-card kct-card-interactive flex flex-col justify-between p-3.5 sm:p-4">
          <div className="flex items-center justify-between text-muted">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">Memory Allocation</span>
            <Activity className="h-4 w-4 text-muted" aria-hidden="true" />
          </div>
          <div className="mt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-primary font-mono">
                {formatMemory(totalMemory)}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted">
              Committed container memory quota
            </p>
          </div>
        </div>

        {/* Metric 4: Storage Footprint */}
        <div className="kct-card kct-card-interactive flex flex-col justify-between p-3.5 sm:p-4">
          <div className="flex items-center justify-between text-muted">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">Storage Footprint</span>
            <HardDrive className="h-4 w-4 text-muted" aria-hidden="true" />
          </div>
          <div className="mt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-primary font-mono">
                {totalStorage} GB
              </span>
              <span className="text-xs text-muted">total</span>
            </div>
            <p className="mt-2 text-xs text-muted">
              Configured rootfs storage volume
            </p>
          </div>
        </div>
      </div>

      {/* Bento Row 2: Infrastructure Nodes (7 cols) & Fleet State (5 cols) */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        {/* Node Infrastructure Bento Tile (7 cols) */}
        <div className="kct-card p-4 sm:p-5 lg:col-span-7 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Network className="h-4 w-4 text-muted" />
                <h2 className="text-sm font-semibold text-primary">Virtualization Nodes</h2>
                <StatusBadge status={data.infra_status === "ok" ? "online" : data.infra_status} />
              </div>
              <Link
                to="/admin/nodes"
                className="inline-flex items-center gap-1 text-xs text-muted hover:text-primary transition-colors"
              >
                <span>Manage nodes</span>
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            <p className="mt-1 text-xs text-muted">
              {data.nodes_total} {data.nodes_total === 1 ? "node" : "nodes"} registered in cluster. Host integration:{" "}
              <span className="font-mono text-primary">{data.infra_status}</span>.
            </p>

            {/* Nodes Listing Table/Cards */}
            <div className="mt-3.5 space-y-2">
              {!data.infra_configured || data.nodes.length === 0 ? (
                <EmptyState
                  title="No virtualization node configured"
                  hint="Register a local or remote node under Nodes to begin provisioning LXC containers."
                />
              ) : (
                data.nodes.map((n) => (
                  <div
                    key={n.id}
                    className="flex flex-col gap-2 rounded border border-border bg-subtle/30 p-2.5 sm:flex-row sm:items-center sm:justify-between hover:bg-raised transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-primary">{n.name}</span>
                        <span className="font-mono text-xs text-muted truncate max-w-[220px]">
                          {n.endpoint}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted">
                        Last heartbeat: {formatRelativeTime(n.last_seen_at)}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <StatusBadge status={n.status} />
                      <Link
                        to="/admin/nodes"
                        className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-primary hover:border-highlight transition-colors"
                      >
                        Inspect
                      </Link>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Host Utilization Telemetry (When reported by host agent) */}
          {data.utilization && Object.keys(data.utilization).length > 0 ? (
            <div className="mt-4 pt-3.5 border-t border-border">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Live Host Telemetry</span>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Object.entries(data.utilization).map(([k, v]) => (
                  <div key={k} className="rounded border border-border bg-subtle/40 px-2.5 py-1.5">
                    <dt className="text-[10px] uppercase font-mono text-muted">{k}</dt>
                    <dd className="text-xs font-semibold text-primary font-mono mt-0.5 truncate">
                      {typeof v === "object" ? JSON.stringify(v) : String(v ?? "—")}
                    </dd>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* Fleet Distribution & Health (5 cols) */}
        <div className="kct-card p-4 sm:p-5 lg:col-span-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted" />
                <h2 className="text-sm font-semibold text-primary">Fleet Distribution</h2>
              </div>
              <Link
                to="/admin/instances"
                className="inline-flex items-center gap-1 text-xs text-muted hover:text-primary transition-colors"
              >
                <span>All instances</span>
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <p className="mt-1 text-xs text-muted">
              Live status reconciliation across all accounts.
            </p>

            {/* State items */}
            <div className="mt-4 space-y-2.5">
              <div className="flex items-center justify-between rounded border border-border bg-subtle/20 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-xs font-medium text-primary">Running Containers</span>
                </div>
                <div className="text-xs font-mono font-semibold text-primary">
                  {runningCount} <span className="text-muted font-normal">({runningPercent}%)</span>
                </div>
              </div>

              <div className="flex items-center justify-between rounded border border-border bg-subtle/20 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-zinc-500" />
                  <span className="text-xs font-medium text-primary">Stopped Containers</span>
                </div>
                <div className="text-xs font-mono font-semibold text-primary">
                  {stoppedCount} <span className="text-muted font-normal">({stoppedPercent}%)</span>
                </div>
              </div>

              <div className="flex items-center justify-between rounded border border-border bg-subtle/20 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  <span className="text-xs font-medium text-primary">Suspended / Missing</span>
                </div>
                <div className="text-xs font-mono font-semibold text-primary">
                  {otherCount} <span className="text-muted font-normal">({otherPercent}%)</span>
                </div>
              </div>
            </div>

            {/* Segmented bar */}
            <div className="mt-3.5 flex h-2 w-full overflow-hidden rounded bg-mid">
              <div style={{ width: `${runningPercent}%` }} className="bg-emerald-500" />
              <div style={{ width: `${stoppedPercent}%` }} className="bg-zinc-600" />
              <div style={{ width: `${otherPercent}%` }} className="bg-amber-500" />
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-xs text-muted">
            <span>Registered Users: <strong className="text-primary font-mono">{data.users_total}</strong></span>
            <Link to="/admin/users" className="hover:text-primary underline">
              View Accounts
            </Link>
          </div>
        </div>
      </div>

      {/* Bento Row 3: Administration Shortcuts (5 cols) & Live Audit Stream (7 cols) */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        {/* Quick Administration Tile (5 cols) */}
        <div className="kct-card p-4 sm:p-5 lg:col-span-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted" />
              <h2 className="text-sm font-semibold text-primary">Administration Shortcuts</h2>
            </div>
            <p className="mt-1 text-xs text-muted">
              Direct access to configuration and account controls.
            </p>

            <div className="mt-3.5 flex flex-col gap-1.5">
              <Link
                to="/admin/create"
                className="flex items-center justify-between rounded border border-border p-2.5 text-xs text-primary hover:border-highlight hover:bg-raised transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Plus className="h-3.5 w-3.5 text-muted" />
                  <span>Provision New VPS Container</span>
                </div>
                <ArrowRight className="h-3 w-3 text-muted" />
              </Link>

              <Link
                to="/admin/users"
                className="flex items-center justify-between rounded border border-border p-2.5 text-xs text-primary hover:border-highlight hover:bg-raised transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Users className="h-3.5 w-3.5 text-muted" />
                  <span>Manage User Accounts ({data.users_total})</span>
                </div>
                <ArrowRight className="h-3 w-3 text-muted" />
              </Link>

              <Link
                to="/admin/nodes"
                className="flex items-center justify-between rounded border border-border p-2.5 text-xs text-primary hover:border-highlight hover:bg-raised transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Network className="h-3.5 w-3.5 text-muted" />
                  <span>Virtualization Nodes ({data.nodes_total})</span>
                </div>
                <ArrowRight className="h-3 w-3 text-muted" />
              </Link>

              <Link
                to="/admin/api-keys"
                className="flex items-center justify-between rounded border border-border p-2.5 text-xs text-primary hover:border-highlight hover:bg-raised transition-colors"
              >
                <div className="flex items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 text-muted" />
                  <span>Admin API Keys</span>
                </div>
                <ArrowRight className="h-3 w-3 text-muted" />
              </Link>

              <Link
                to="/admin/settings"
                className="flex items-center justify-between rounded border border-border p-2.5 text-xs text-primary hover:border-highlight hover:bg-raised transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Settings className="h-3.5 w-3.5 text-muted" />
                  <span>System Settings & Branding</span>
                </div>
                <ArrowRight className="h-3 w-3 text-muted" />
              </Link>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-xs text-muted font-mono">
            <span>Panel v{data.app_version}</span>
            <span>Schema v{data.migration_version}</span>
          </div>
        </div>

        {/* Real-time Audit Trail Tile (7 cols) */}
        <div className="kct-card p-4 sm:p-5 lg:col-span-7 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted" />
                <h2 className="text-sm font-semibold text-primary">Audit Log Activity</h2>
              </div>
              <span className="text-xs text-muted font-mono">
                Latest {data.recent_events.length} actions
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              Immutable audit events recorded in database.
            </p>

            <div className="mt-3.5">
              {data.recent_events.length === 0 ? (
                <EmptyState
                  title="No administrative events yet"
                  hint="Operations performed across the panel will stream here in real time."
                />
              ) : (
                <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1 kct-scroll">
                  {data.recent_events.slice(0, 10).map((e) => (
                    <div
                      key={e.id}
                      className="flex items-center justify-between gap-2 rounded border border-border bg-subtle/20 px-3 py-2 text-xs hover:bg-raised transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-primary font-medium bg-raised px-1.5 py-0.5 rounded border border-border">
                          {e.action}
                        </span>
                        {e.target_type ? (
                          <span className="font-mono text-muted text-[11px] truncate max-w-[150px]">
                            {e.target_type}
                            {e.target_id ? `:${e.target_id.slice(0, 8)}` : ""}
                          </span>
                        ) : null}
                      </div>
                      <span className="text-[11px] text-muted shrink-0">
                        {formatRelativeTime(e.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 pt-2 text-[11px] text-muted text-right">
            All records read directly from live host integration & SQLite.
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdminOverviewPage;
