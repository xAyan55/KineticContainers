import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Cpu,
  HardDrive,
  MemoryStick,
  Network as NetworkIcon,
  Power,
  RefreshCw,
  RotateCcw,
  Square,
  StickyNote,
  Terminal as TerminalIcon,
  Key,
  Lock,
  Eye,
  EyeOff,
  AlertTriangle,
  Check,
} from "lucide-react";
import { ApiError, api, apiBase, type Instance } from "@/lib/api";
import { useAuth } from "@/features/auth/AuthContext";
import {
  Button,
  Card,
  EmptyState,
  InlineAlert,
  Input,
  Label,
  PageHeader,
  StatusBadge,
} from "@/components/ui/primitives";
import { KineticTerminal } from "@/components/terminal/KineticTerminal";
import { FilesTab } from "@/pages/InstanceFiles";
import { VpsDetailFeatures } from "@/components/ui/vps-detail-features";
import { VpsAnalyticsBento } from "@/components/ui/vps-analytics-bento";

const LiveConsumptionCharts = React.lazy(() =>
  import("@/components/ui/live-consumption-chart").then((m) => ({ default: m.LiveConsumptionCharts }))
);

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

export interface LiveState {
  exists: boolean | null;
  status: string | null;
  checkedAt: string;
  error: string | null;
}

export interface InstanceDetail {
  instance: Instance;
  live: LiveState;
}

function useInstance(id: string | undefined) {
  const [detail, setDetail] = React.useState<InstanceDetail | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await api.get<InstanceDetail>(`/api/instances/${id}`);
      setDetail(data);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load instance.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  return { detail, error, loading, load, setDetail, setError };
}

function PowerControls({
  detail,
  onDone,
  compact,
}: {
  detail: InstanceDetail;
  onDone: () => void;
  compact?: boolean;
}) {
  const [acting, setActing] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const liveStatus = detail.live.exists === true ? detail.live.status : null;
  const isRunning = liveStatus === "running";
  const isStopped = liveStatus === "stopped";
  const unknown = detail.live.exists !== true || (!isRunning && !isStopped);
  const suspended = detail.instance.status === "suspended";

  const act = async (action: "start" | "stop" | "restart"): Promise<void> => {
    setActing(action);
    setError(undefined);
    try {
      await api.post(`/api/instances/${detail.instance.id}/actions`, { action });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Operation failed.");
    } finally {
      setActing(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => void act("start")}
          disabled={acting !== null || isRunning || suspended}
          title={suspended ? "Suspended — ask an administrator to unsuspend first" : isRunning ? "Already running" : "Start"}
        >
          {acting === "start" ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Power className="h-4 w-4" aria-hidden="true" />}
          {compact ? null : "Start"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void act("stop")}
          disabled={acting !== null || isStopped || suspended}
          title={suspended ? "Suspended — ask an administrator to unsuspend first" : isStopped ? "Already stopped" : "Stop"}
        >
          {acting === "stop" ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Square className="h-4 w-4" aria-hidden="true" />}
          {compact ? null : "Stop"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void act("restart")}
          disabled={acting !== null || unknown || suspended}
          title={suspended ? "Suspended — ask an administrator to unsuspend first" : "Restart"}
        >
          {acting === "restart" ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-4 w-4" aria-hidden="true" />}
          {compact ? null : "Restart"}
        </Button>
      </div>
      {suspended && !compact ? (
        <p className="mt-2 text-xs text-muted">
          This VPS is suspended by an administrator. Power actions are blocked until it is unsuspended.
        </p>
      ) : null}
      {unknown && !suspended && !compact ? (
        <p className="mt-2 text-xs text-muted">
          {detail.live.exists === false
            ? "Container is missing on the host; power actions will fail until it is recreated."
            : detail.live.exists === null
              ? "Host container state is unknown; actions may fail."
              : "Container is transitioning; actions unlock when it settles."}
        </p>
      ) : null}
      <InlineAlert message={error} />
    </div>
  );
}

export function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 break-words text-sm text-primary ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  );
}

export class TabErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(error: Error): { failed: boolean; error: Error } {
    return { failed: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("Tab rendering error:", error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <Card>
          <p className="text-sm font-semibold text-primary">This section failed to render.</p>
          <p className="mt-1 text-sm text-muted">
            {this.state.error?.message
              ? `Details: ${this.state.error.message}`
              : "The data returned was not in the expected shape. Other tabs are unaffected."}
          </p>
          <div className="mt-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => this.setState({ failed: false, error: undefined })}
            >
              Try again
            </Button>
          </div>
        </Card>
      );
    }
    return this.props.children;
  }
}

export function OverviewTab({ detail, onRefresh }: { detail: InstanceDetail; onRefresh: () => void }) {
  const running = detail.live.exists === true && detail.live.status === "running";
  const i = detail.instance;
  return (
    <div className="flex flex-col gap-5">
      {detail.live.exists === false ? (
        <InlineAlert message={detail.live.error ?? "Container not found on the host. The database record may be stale."} />
      ) : null}
      {detail.live.exists === null ? (
        <InlineAlert message={detail.live.error ?? "Live host state is currently unavailable."} />
      ) : null}

      {/* VPS Live Telemetry Bento Grid */}
      <VpsAnalyticsBento detail={detail} />

      <Card>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Status" value={<StatusBadge status={detail.live.exists ? (detail.live.status ?? "unknown") : "unknown"} />} />
          <Fact label="Container identifier" value={i.container_id} mono />
          <Fact label="Node" value={i.node_name ?? "—"} />
          <Fact label="Template" value={i.template ?? "—"} />
          <Fact label="Created" value={formatDateTime(i.created_at)} />
          <Fact label="Live state confirmed" value={formatDateTime(detail.live.checkedAt)} />
          <Fact label="CPU (configured)" value={`${i.cpu} vCPU`} />
          <Fact label="Memory (configured)" value={`${i.memory_mb} MB`} />
          <Fact label="Disk (recorded)" value={`${i.storage_gb} GB`} />
        </div>
      </Card>
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-primary">Live consumption</h2>
        <React.Suspense fallback={<p className="text-sm text-muted" role="status">Loading charts…</p>}>
          <LiveConsumptionCharts
            instanceId={i.id}
            running={running}
            vcpu={i.cpu}
            memoryLimitMb={i.memory_mb}
          />
        </React.Suspense>
        <p className="mt-3 text-xs text-muted">Configured limits above are enforced by the host; live values are reported by LXC.</p>
      </Card>
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-primary">Power</h2>
        <PowerControls detail={detail} onDone={onRefresh} />
      </Card>
    </div>
  );
}

export function ConsoleTab({
  instanceId,
  instanceName,
  running,
  onRefreshInstance,
}: {
  instanceId: string;
  instanceName?: string;
  running?: boolean;
  onRefreshInstance?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <KineticTerminal
        instanceId={instanceId}
        instanceName={instanceName}
        running={running}
        onRefreshInstance={onRefreshInstance}
      />
    </div>
  );
}

export function ResourcesTab({ detail, onRefresh, isAdmin }: { detail: InstanceDetail; onRefresh: () => void; isAdmin: boolean }) {
  const i = detail.instance;
  const [config, setConfig] = React.useState<null | {
    configured: { cpu: number; memory_mb: number; storage_gb: number };
    effective: {
      cpu: number | null;
      memoryMb: number | null;
      cpuset: string | null;
      cpusetCpus: number | null;
      cpuModel: string;
      storageGb: null;
      storageEnforced: false;
      storageNote: string;
      cgroupVersion: string;
    };
    storage: {
      backend: string;
      quotaSupported: boolean;
      quotaGb: number | null;
      usedGb: number | null;
      note: string;
    } | null;
    lxcfs: { active: boolean } | null;
  }>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [cpu, setCpu] = React.useState(String(i.cpu));
  const [memoryMb, setMemoryMb] = React.useState(String(i.memory_mb));
  const [diskGb, setDiskGb] = React.useState(String(i.storage_gb));
  const [saving, setSaving] = React.useState(false);
  const [result, setResult] = React.useState<string | undefined>();
  const diskEditable = config?.storage?.quotaSupported === true;

  const loadConfig = React.useCallback(async () => {
    try {
      const data = await api.get<{
        configured: { cpu: number; memory_mb: number; storage_gb: number };
        effective: {
          cpu: number | null;
          memoryMb: number | null;
          cpuset: string | null;
          cpusetCpus: number | null;
          cpuModel: string;
          storageGb: null;
          storageEnforced: false;
          storageNote: string;
          cgroupVersion: string;
        };
        storage: {
          backend: string;
          quotaSupported: boolean;
          quotaGb: number | null;
          usedGb: number | null;
          note: string;
        } | null;
        lxcfs: { active: boolean } | null;
      }>(`/api/instances/${i.id}/config`);
      setConfig(data);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load effective configuration.");
    }
  }, [i.id]);

  React.useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    setResult(undefined);
    try {
      const data = await api.patch<{
        liveApplied: boolean;
        restartRequired: boolean;
        cgroupVersion: string;
      }>(`/api/instances/${i.id}/resources`, { cpu: Number(cpu), memory_mb: Number(memoryMb), storage_gb: Number(diskGb) });
      setResult(
        data.liveApplied
          ? `Limits applied live (cgroup ${data.cgroupVersion}).`
          : data.restartRequired
            ? "Limits saved to configuration; restart the container to apply them."
            : "Limits saved to configuration and will apply on next start."
      );
      setCpu(String(i.cpu));
      await loadConfig();
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update resources.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <InlineAlert message={error} />
      {result ? (
        <div role="status" className="rounded-md border border-border bg-raised px-3 py-2 text-sm text-primary">
          {result}
        </div>
      ) : null}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-primary">Configured vs enforced</h2>
        {!config ? (
          <p className="text-sm text-muted" role="status">Loading effective configuration…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="kct-table w-full min-w-[520px] border-collapse">
              <thead>
                <tr><th scope="col">Resource</th><th scope="col">Configured</th><th scope="col">Effective on host</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-primary">CPU</td>
                  <td className="text-muted">{config.configured?.cpu ?? i.cpu} vCPU</td>
                  <td className="text-muted">{config.effective?.cpu !== null && config.effective?.cpu !== undefined ? `${config.effective.cpu} vCPU (cgroup ${config.effective.cgroupVersion ?? "v2"})` : "Unavailable"}</td>
                </tr>
                <tr>
                  <td className="text-primary">CPU visibility</td>
                  <td className="text-muted">{config.configured?.cpu ?? i.cpu} vCPU</td>
                  <td className="text-muted">
                    {config.effective?.cpuset !== null && config.effective?.cpuset !== undefined
                      ? `cpuset ${config.effective.cpuset} (${config.effective.cpusetCpus ?? "?"} visible) — shared set, not dedicated cores`
                      : "Unavailable"}
                  </td>
                </tr>
                <tr>
                  <td className="text-primary">Memory</td>
                  <td className="text-muted">{config.configured?.memory_mb ?? i.memory_mb} MB</td>
                  <td className="text-muted">{config.effective?.memoryMb !== null && config.effective?.memoryMb !== undefined ? `${config.effective.memoryMb} MB (cgroup ${config.effective.cgroupVersion ?? "v2"})` : "Unavailable"}</td>
                </tr>
                <tr>
                  <td className="text-primary">Disk</td>
                  <td className="text-muted">{config.configured?.storage_gb ?? i.storage_gb} GB (recorded)</td>
                  <td className="text-muted">
                    {!config.storage
                      ? "Unavailable"
                      : config.storage.quotaSupported && config.storage.quotaGb !== null
                        ? `${config.storage.quotaGb} GB quota enforced (${config.storage.backend}, ${config.storage.usedGb ?? "?"} GB used)`
                        : `${config.storage.backend} backend — no quota. ${config.storage.usedGb !== null ? `${config.storage.usedGb} GB used. ` : ""}${config.storage.note}`}
                  </td>
                </tr>
                <tr>
                  <td className="text-primary">LXCFS views</td>
                  <td className="text-muted">Container-aware /proc + /sys</td>
                  <td className="text-muted">
                    {!config.lxcfs ? "Unavailable" : config.lxcfs.active ? "Active in guest" : "Not mounted in guest"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mb-1 text-sm font-semibold text-primary">Change limits</h2>
        {!isAdmin ? (
          <p className="text-sm text-muted">Only administrators can change resource allocations. Contact your administrator if this VPS needs different specs.</p>
        ) : (
        <>
        <p className="mb-4 text-xs text-muted">CPU and memory are enforced through cgroup limits{config?.effective?.cgroupVersion ? ` (${config.effective.cgroupVersion})` : ""} and applied live when the container runs. {diskEditable ? "Disk quota is enforceable on this backend and can be changed below." : "Disk quotas are not enforceable on this backend."}</p>
        <form onSubmit={(e) => void save(e)} className="grid max-w-lg gap-4">
          <div>
            <Label htmlFor="res-cpu">CPU (vCPU, 1–32)</Label>
            <Input id="res-cpu" type="number" min={1} max={32} value={cpu} onChange={(e) => setCpu(e.target.value)} required disabled={saving} />
          </div>
          <div>
            <Label htmlFor="res-mem">Memory (MB, 128–131072)</Label>
            <Input id="res-mem" type="number" min={128} max={131072} step={128} value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} required disabled={saving} />
          </div>
          <div>
            <Label htmlFor="res-disk">Disk (GB)</Label>
            <Input id="res-disk" type="number" min={1} max={2000} value={diskGb} onChange={(e) => setDiskGb(e.target.value)} required disabled={saving || !diskEditable} aria-describedby="disk-note" />
            <p id="disk-note" className="mt-1 text-xs text-muted">
              {diskEditable
                ? "Enforced as a real quota on this backend."
                : "Recorded only — quotas cannot be enforced on this backend."}
            </p>
          </div>
          <div>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save limits"}</Button>
          </div>
        </form>
        </>
        )}
      </Card>
      {isAdmin ? (
        <RepairCard instanceId={i.id} onRepaired={() => { void loadConfig(); onRefresh(); }} />
      ) : null}
    </div>
  );
}

interface RepairPlanCheck {
  check: string;
  status: "ok" | "needs-fix" | "unsupported";
  detail: string;
}

interface RepairPlan {
  containerId: string;
  exists: boolean;
  checks: RepairPlanCheck[];
  restartNeeded: boolean;
  warnings: string[];
}

interface RepairReport {
  containerId: string;
  backupPath: string | null;
  checks: { check: string; status: string; detail: string }[];
  restartNeeded: boolean;
  warnings: string[];
}

export function RepairCard({ instanceId, onRepaired }: { instanceId: string; onRepaired: () => void }): React.JSX.Element {
  const [plan, setPlan] = React.useState<RepairPlan | null>(null);
  const [report, setReport] = React.useState<RepairReport | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [busy, setBusy] = React.useState(false);

  const loadPlan = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const data = await api.get<{ plan: RepairPlan }>(`/api/instances/${instanceId}/repair`);
      setPlan(data.plan);
      setReport(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to compute repair plan.");
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const data = await api.post<{ report: RepairReport }>(`/api/instances/${instanceId}/repair`);
      setReport(data.report);
      onRepaired();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Repair failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-primary">Repair drift</h2>
      <p className="mb-4 text-xs text-muted">
        Compares this VPS against the host and fixes drift (limits, affinity set, LXCFS include, btrfs quota).
        Config is backed up once before any change; containers are never recreated or migrated.
      </p>
      <InlineAlert message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={() => void loadPlan()} disabled={busy}>
          {busy ? "Working…" : "Check for drift"}
        </Button>
        {plan && plan.exists ? (
          <Button type="button" onClick={() => void apply()} disabled={busy}>
            {busy ? "Repairing…" : "Apply repair"}
          </Button>
        ) : null}
      </div>
      {plan ? (
        <ul className="mt-4 flex flex-col gap-1.5">
          {plan.checks.map((c) => (
            <li key={c.check} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <span className="font-mono text-xs text-muted">{c.check}</span>
              <span className="flex-1 text-muted">{c.detail}</span>
              <StatusBadge status={c.status === "needs-fix" ? "unknown" : c.status === "ok" ? "active" : "disabled"} />
            </li>
          ))}
        </ul>
      ) : null}
      {plan && !plan.exists ? (
        <p className="mt-3 text-sm text-muted">The container is missing on the host — recreate it instead of repairing.</p>
      ) : null}
      {report ? (
        <div className="mt-4">
          <p className="mb-2 text-xs text-muted">
            Repair applied{report.backupPath ? ` (config backup: ${report.backupPath})` : ""}.
            {report.restartNeeded ? " A container restart is required for all changes to take effect." : ""}
          </p>
          <ul className="flex flex-col gap-1.5">
            {report.checks.map((c) => (
              <li key={c.check} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <span className="font-mono text-xs text-muted">{c.check}</span>
                <span className="flex-1 text-muted">{c.detail}</span>
                <StatusBadge status={c.status === "fixed" ? "active" : c.status === "ok" ? "active" : c.status === "failed" ? "error" : "disabled"} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

export function NetworkTab({ detail }: { detail: InstanceDetail }) {
  const [network, setNetwork] = React.useState<null | {
    state: string;
    pid: number | null;
    ipv4: string[];
    ipv6: string[];
    links: string[];
    bridge: string | null;
  }>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<{
        network: {
          state: string;
          pid: number | null;
          ipv4: string[];
          ipv6: string[];
          links: string[];
          bridge: string | null;
        } | null;
      }>(`/api/instances/${detail.instance.id}/network`)
      .then((d) => {
        if (!cancelled) {
          setNetwork(d.network);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Unable to load network info.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detail.instance.id]);

  return (
    <Card>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-primary">
        <NetworkIcon className="h-4 w-4" aria-hidden="true" /> Container network
      </h2>
      <p className="mb-4 text-xs text-muted">Live facts from the host. Private addresses are not publicly reachable.</p>
      <InlineAlert message={error} />
      {loading ? (
        <p className="text-sm text-muted" role="status">Reading network info…</p>
      ) : !network ? null : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Fact label="State" value={network.state ?? "UNKNOWN"} />
          <Fact label="Bridge" value={network.bridge ?? "Unavailable"} mono />
          <Fact label="IPv4" value={(network.ipv4 ?? []).length > 0 ? (network.ipv4 ?? []).join(", ") : "None reported"} mono />
          <Fact label="IPv6" value={(network.ipv6 ?? []).length > 0 ? (network.ipv6 ?? []).join(", ") : "None reported"} mono />
          <Fact label="Interfaces" value={(network.links ?? []).length > 0 ? (network.links ?? []).join(", ") : "Unavailable"} mono />
          <Fact label="Host PID" value={network.pid !== null && network.pid !== undefined ? String(network.pid) : "—"} />
        </div>
      )}
      {!loading && network && (network.ipv4 ?? []).length === 0 && (network.ipv6 ?? []).length === 0 ? (
        <p className="mt-3 text-xs text-muted">No address reported — the container is likely stopped, or DHCP on the bridge has not assigned one yet.</p>
      ) : null}
    </Card>
  );
}

const TEMPLATE_NAMES: Record<string, string> = {
  "ubuntu-24.04": "Ubuntu 24.04 LTS (Noble)",
  "ubuntu-22.04": "Ubuntu 22.04 LTS (Jammy)",
  "debian-12": "Debian 12 (Bookworm)",
  "alpine-3.20": "Alpine Linux 3.20 (Minimal)",
};

export function SettingsTab({
  detail,
  onRefresh,
  isAdmin,
  onDeleted,
}: {
  detail: InstanceDetail;
  onRefresh: () => void;
  isAdmin: boolean;
  /** Where to go after a successful delete. Defaults to the user dashboard. */
  onDeleted?: () => void;
}) {
  const navigate = useNavigate();
  const i = detail.instance;
  const [name, setName] = React.useState(i.name);
  const [error, setError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();
  const [saving, setSaving] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [suspending, setSuspending] = React.useState(false);
  const [confirmSuspend, setConfirmSuspend] = React.useState(false);
  const suspended = i.status === "suspended";

  // Root Password state
  const [rootPassword, setRootPassword] = React.useState("");
  const [confirmRootPassword, setConfirmRootPassword] = React.useState("");
  const [showRootPassword, setShowRootPassword] = React.useState(false);
  const [savingPassword, setSavingPassword] = React.useState(false);

  // OS Reinstall state
  const [templates, setTemplates] = React.useState<string[]>([]);
  const [selectedTemplate, setSelectedTemplate] = React.useState(i.template ?? "ubuntu-22.04");
  const [reinstallPassword, setReinstallPassword] = React.useState("");
  const [confirmReinstallPassword, setConfirmReinstallPassword] = React.useState("");
  const [showReinstallPassword, setShowReinstallPassword] = React.useState(false);
  const [confirmWipe, setConfirmWipe] = React.useState(false);
  const [reinstalling, setReinstalling] = React.useState(false);
  const [showReinstallDialog, setShowReinstallDialog] = React.useState(false);

  React.useEffect(() => {
    api.get<{ templates: string[] }>("/api/templates")
      .then((res) => {
        if (res.templates && res.templates.length > 0) {
          setTemplates(res.templates);
          if (!res.templates.includes(selectedTemplate)) {
            setSelectedTemplate(res.templates[0]);
          }
        }
      })
      .catch(() => {
        setTemplates(["ubuntu-24.04", "ubuntu-22.04", "debian-12", "alpine-3.20"]);
      });
  }, []);

  const handlePasswordSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (rootPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (rootPassword !== confirmRootPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSavingPassword(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.post(`/api/instances/${i.id}/password`, { password: rootPassword });
      setNotice("Root password updated successfully.");
      setRootPassword("");
      setConfirmRootPassword("");
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update root password.");
    } finally {
      setSavingPassword(false);
    }
  };

  const handleReinstallSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!confirmWipe) {
      setError("Please confirm that you understand this will permanently erase all data on the VPS.");
      return;
    }
    if (reinstallPassword && reinstallPassword.length < 8) {
      setError("New root password must be at least 8 characters.");
      return;
    }
    if (reinstallPassword && reinstallPassword !== confirmReinstallPassword) {
      setError("Reinstall passwords do not match.");
      return;
    }
    setReinstalling(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.post(`/api/instances/${i.id}/reinstall`, {
        template: selectedTemplate,
        root_password: reinstallPassword || undefined,
      });
      setNotice(`Operating system successfully reinstalled as ${selectedTemplate}.`);
      setShowReinstallDialog(false);
      setConfirmWipe(false);
      setReinstallPassword("");
      setConfirmReinstallPassword("");
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reinstallation failed.");
    } finally {
      setReinstalling(false);
    }
  };

  const setSuspended = async (lift: boolean): Promise<void> => {
    setSuspending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.post(`/api/instances/${i.id}/${lift ? "unsuspend" : "suspend"}`, {});
      setNotice(lift ? "Suspension lifted. The container was not started." : "VPS suspended. Power actions are blocked until unsuspended.");
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change suspension.");
    } finally {
      setSuspending(false);
      setConfirmSuspend(false);
    }
  };

  const saveName = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.patch(`/api/instances/${i.id}`, { name: name.trim() });
      setNotice("Display name updated.");
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rename.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    setDeleting(true);
    setError(undefined);
    try {
      await api.del(`/api/instances/${i.id}`);
      if (onDeleted) onDeleted();
      else navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete.");
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <InlineAlert message={error} />
      {notice ? (
        <div role="status" className="rounded-md border border-border bg-raised px-3 py-2 text-sm text-primary">
          {notice}
        </div>
      ) : null}

      {/* Root Password Card */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <Key className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-primary">Root Password</h2>
        </div>
        <p className="mb-4 text-xs text-muted">
          Change the root password for console and SSH access. Works whether the VPS is running or stopped.
        </p>
        <form onSubmit={(e) => void handlePasswordSubmit(e)} className="flex max-w-md flex-col gap-3">
          <div>
            <Label htmlFor="root-pw">New root password</Label>
            <div className="relative">
              <Input
                id="root-pw"
                type={showRootPassword ? "text" : "password"}
                value={rootPassword}
                onChange={(e) => setRootPassword(e.target.value)}
                required
                minLength={8}
                maxLength={128}
                placeholder="••••••••••••"
                disabled={savingPassword || suspended}
              />
              <button
                type="button"
                onClick={() => setShowRootPassword(!showRootPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted hover:text-primary transition-colors cursor-pointer"
                tabIndex={-1}
                aria-label={showRootPassword ? "Hide password" : "Show password"}
              >
                {showRootPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div>
            <Label htmlFor="confirm-root-pw">Confirm root password</Label>
            <Input
              id="confirm-root-pw"
              type={showRootPassword ? "text" : "password"}
              value={confirmRootPassword}
              onChange={(e) => setConfirmRootPassword(e.target.value)}
              required
              minLength={8}
              maxLength={128}
              placeholder="••••••••••••"
              disabled={savingPassword || suspended}
            />
          </div>
          <div>
            <Button type="submit" disabled={savingPassword || suspended || !rootPassword}>
              {savingPassword ? "Updating password…" : "Update root password"}
            </Button>
          </div>
        </form>
      </Card>

      {/* Reinstall Operating System Card */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <RotateCcw className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-primary">Reinstall Operating System</h2>
        </div>
        <p className="mb-4 text-xs text-muted">
          Wipe the container filesystem and deploy a clean operating system template.
        </p>

        {!showReinstallDialog ? (
          <div>
            <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3.5 mb-4 text-xs text-amber-200/90 flex gap-2.5 items-start">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-amber-300">Data Loss Warning:</span> Reinstalling will permanently delete all files, configurations, and installed packages on this VPS. IP addresses and resource allocations remain preserved.
              </div>
            </div>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setShowReinstallDialog(true);
                setConfirmWipe(false);
              }}
              disabled={suspended}
            >
              Reinstall Operating System…
            </Button>
          </div>
        ) : (
          <form onSubmit={(e) => void handleReinstallSubmit(e)} className="flex max-w-lg flex-col gap-4">
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-300 flex gap-2.5 items-start">
              <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-rose-200">Destructive Operation:</span> All data inside <span className="font-mono text-primary">{i.container_id}</span> will be permanently erased.
              </div>
            </div>

            <div>
              <Label htmlFor="reinstall-tpl">Target Operating System</Label>
              <select
                id="reinstall-tpl"
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                className="kct-input w-full cursor-pointer"
                disabled={reinstalling}
              >
                {templates.map((tpl) => (
                  <option key={tpl} value={tpl}>
                    {TEMPLATE_NAMES[tpl] ?? tpl}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="reinstall-pw">New root password (optional)</Label>
              <div className="relative">
                <Input
                  id="reinstall-pw"
                  type={showReinstallPassword ? "text" : "password"}
                  value={reinstallPassword}
                  onChange={(e) => setReinstallPassword(e.target.value)}
                  minLength={8}
                  maxLength={128}
                  placeholder="Set password for new OS (minimum 8 chars)"
                  disabled={reinstalling}
                />
                <button
                  type="button"
                  onClick={() => setShowReinstallPassword(!showReinstallPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted hover:text-primary transition-colors cursor-pointer"
                  tabIndex={-1}
                  aria-label={showReinstallPassword ? "Hide password" : "Show password"}
                >
                  {showReinstallPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {reinstallPassword ? (
              <div>
                <Label htmlFor="confirm-reinstall-pw">Confirm new root password</Label>
                <Input
                  id="confirm-reinstall-pw"
                  type={showReinstallPassword ? "text" : "password"}
                  value={confirmReinstallPassword}
                  onChange={(e) => setConfirmReinstallPassword(e.target.value)}
                  minLength={8}
                  maxLength={128}
                  placeholder="Repeat new password"
                  disabled={reinstalling}
                />
              </div>
            ) : null}

            <div className="flex items-start gap-2.5 pt-1">
              <input
                id="confirm-wipe-checkbox"
                type="checkbox"
                checked={confirmWipe}
                onChange={(e) => setConfirmWipe(e.target.checked)}
                className="h-4 w-4 mt-0.5 accent-white cursor-pointer"
                disabled={reinstalling}
              />
              <Label htmlFor="confirm-wipe-checkbox" className="text-xs text-muted cursor-pointer leading-relaxed">
                I understand that this action is irreversible and will permanently wipe all existing files, databases, and configuration on this server.
              </Label>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button
                type="submit"
                variant="danger"
                disabled={reinstalling || !confirmWipe}
              >
                {reinstalling ? "Reinstalling OS (may take up to a minute)…" : `Confirm Reinstall ${selectedTemplate}`}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowReinstallDialog(false);
                  setConfirmWipe(false);
                  setReinstallPassword("");
                  setConfirmReinstallPassword("");
                }}
                disabled={reinstalling}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Card>

      {isAdmin ? (
      <Card>
        <h2 className="mb-4 text-sm font-semibold text-primary">Display name</h2>
        <form onSubmit={(e) => void saveName(e)} className="flex max-w-md flex-col gap-3">
          <div>
            <Label htmlFor="set-name">Name</Label>
            <Input id="set-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={63} disabled={saving} />
          </div>
          <div>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save name"}</Button>
          </div>
        </form>
      </Card>
      ) : null}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-primary">Details</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Fact label="Container identifier (immutable)" value={i.container_id} mono />
          <Fact label="Node" value={i.node_name ?? "—"} />
          <Fact label="Configured CPU / RAM / Disk" value={`${i.cpu} vCPU · ${i.memory_mb} MB · ${i.storage_gb} GB`} />
          <Fact label="Template" value={i.template ?? "—"} />
          <Fact label="Created" value={formatDateTime(i.created_at)} />
        </div>
      </Card>
      {isAdmin ? (
      <Card>
        <h2 className="mb-1 text-sm font-semibold text-primary">Suspension</h2>
        <p className="mb-4 text-xs text-muted">
          {suspended
            ? "This VPS is suspended: the container is held stopped and power actions are blocked. Unsuspending lifts the hold without starting the container."
            : "Suspending stops the container when the host can verify it, then blocks start, stop, and restart until an administrator unsuspends. Files and settings remain manageable."}
        </p>
        {!confirmSuspend ? (
          suspended ? (
            <Button type="button" onClick={() => void setSuspended(true)} disabled={suspending}>
              {suspending ? "Unsuspending…" : "Unsuspend VPS"}
            </Button>
          ) : (
            <Button type="button" variant="danger" onClick={() => setConfirmSuspend(true)}>
              Suspend VPS…
            </Button>
          )
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">Suspend <span className="font-mono text-primary">{i.container_id}</span> now?</span>
            <Button type="button" variant="danger" onClick={() => void setSuspended(false)} disabled={suspending}>
              {suspending ? "Suspending…" : "Confirm suspend"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmSuspend(false)} disabled={suspending}>
              Cancel
            </Button>
          </div>
        )}
      </Card>
      ) : null}
      {isAdmin ? (
      <Card>
        <h2 className="mb-1 text-sm font-semibold text-primary">Delete VPS</h2>
        <p className="mb-4 text-xs text-muted">Destroys the exact host container <span className="font-mono">{i.container_id}</span> and removes this record. This cannot be undone.</p>
        {!confirming ? (
          <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
            Delete VPS…
          </Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">Destroy <span className="font-mono text-primary">{i.container_id}</span>?</span>
            <Button type="button" variant="danger" onClick={() => void remove()} disabled={deleting}>
              {deleting ? "Deleting…" : "Confirm delete"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
              Cancel
            </Button>
          </div>
        )}
      </Card>
      ) : null}
    </div>
  );
}

export function NotesTab({
  detail,
  onRefresh,
  isAdmin,
}: {
  detail: InstanceDetail;
  onRefresh: () => void;
  isAdmin: boolean;
}) {
  const i = detail.instance;
  const [value, setValue] = React.useState(i.notes ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();

  // Follow server truth: when the instance (re)loads, adopt its note.
  React.useEffect(() => {
    setValue(i.notes ?? "");
  }, [i.notes, i.id]);

  const save = async (next: string): Promise<void> => {
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.patch(`/api/instances/${i.id}/notes`, { notes: next });
      setNotice(next.trim().length === 0 ? "Note cleared." : "Note saved.");
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the note.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-primary">
        <StickyNote className="h-4 w-4" aria-hidden="true" /> Notes
      </h2>
      <p className="mb-4 text-xs text-muted">
        {isAdmin
          ? "Visible to everyone who can see this VPS. Only administrators can edit it; an empty note is cleared."
          : "Written by an administrator and read-only for VPS owners."}
      </p>
      <InlineAlert message={error} />
      {notice ? (
        <div role="status" className="mb-3 rounded-md border border-border bg-raised px-3 py-2 text-sm text-primary">
          {notice}
        </div>
      ) : null}
      {isAdmin ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(value);
          }}
          className="flex flex-col gap-3"
        >
          <Label htmlFor="instance-notes">Note</Label>
          <textarea
            id="instance-notes"
            className="kct-input min-h-[160px] w-full font-mono text-sm"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={4000}
            disabled={saving}
            placeholder="Administrator note — renewal dates, contacts, special handling…"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save note"}
            </Button>
            {i.notes ? (
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setValue("");
                  void save("");
                }}
              >
                Clear note
              </Button>
            ) : null}
            <span className="text-xs text-muted">{value.length}/4000</span>
          </div>
        </form>
      ) : i.notes ? (
        <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-raised px-3 py-2 font-mono text-sm text-primary">
          {i.notes}
        </pre>
      ) : (
        <EmptyState title="No notes" hint="An administrator has not added a note to this VPS." />
      )}
    </Card>
  );
}

export type TabId = "overview" | "notes" | "console" | "resources" | "network" | "files" | "settings";

export const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "notes", label: "Notes" },
  { id: "console", label: "Console" },
  { id: "resources", label: "Resources" },
  { id: "network", label: "Network" },
  { id: "files", label: "Files" },
  { id: "settings", label: "Settings" },
];

export function InstanceDetailsPage(): React.JSX.Element {
  const { id, tabId } = useParams<{ id: string; tabId?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const tab: TabId = TABS.some((t) => t.id === tabId) ? (tabId as TabId) : "overview";
  const { detail, error, loading, load } = useInstance(id);

  const refresh = React.useCallback(() => {
    void load();
  }, [load]);

  const selectTab = React.useCallback(
    (next: TabId) => {
      if (!id) return;
      navigate(`/instances/${id}/${next}`);
    },
    [id, navigate]
  );

  return (
    <div>
      <div className="mb-4">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-primary">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to dashboard
        </Link>
      </div>
      {loading && !detail ? (
        <p className="text-sm text-muted" role="status">Loading instance…</p>
      ) : error && !detail ? (
        <EmptyState title="Instance not available" hint={error} />
      ) : detail ? (
        <div>
          <PageHeader
            title={detail.instance.name}
            subtitle={`Container ${detail.instance.container_id} · ${detail.instance.node_name ?? "no node"}`}
            actions={
              <div className="flex items-center gap-2">
                <StatusBadge status={detail.live.exists ? (detail.live.status ?? "unknown") : "unknown"} />
                <Button type="button" variant="ghost" onClick={refresh} aria-label="Refresh instance state">
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            }
          />
          <div role="tablist" aria-label="Instance sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                id={`tab-${t.id}`}
                onClick={() => selectTab(t.id)}
                className={`whitespace-nowrap px-3 py-2 text-sm ${
                  tab === t.id
                    ? "border-b-2 border-primary font-medium text-primary"
                    : "text-muted hover:text-primary"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            <TabErrorBoundary key={tab}>
            {tab === "overview" && <OverviewTab detail={detail} onRefresh={refresh} />}
            {tab === "notes" && <NotesTab detail={detail} onRefresh={refresh} isAdmin={isAdmin} />}
            {tab === "console" && (
              <ConsoleTab
                instanceId={detail.instance.id}
                instanceName={detail.instance.name}
                running={detail.live.exists ? detail.live.status === "running" : false}
                onRefreshInstance={refresh}
              />
            )}
            {tab === "resources" && <ResourcesTab detail={detail} onRefresh={refresh} isAdmin={isAdmin} />}
            {tab === "network" && <NetworkTab detail={detail} />}
            {tab === "files" && <FilesTab instanceId={detail.instance.id} />}
            {tab === "settings" && <SettingsTab detail={detail} onRefresh={refresh} isAdmin={isAdmin} />}
            </TabErrorBoundary>
          </div>
        </div>
      ) : null}
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
        <MemoryStick className="h-3.5 w-3.5" aria-hidden="true" />
        <HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Configured limits are enforced through host cgroup settings; disk quotas apply only where the storage backend supports them (see Resources).</span>
      </div>
    </div>
  );
}
