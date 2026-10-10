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
  Terminal as TerminalIcon,
} from "lucide-react";
import { ApiError, api, type Instance } from "@/lib/api";
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
import type { Terminal } from "@xterm/xterm";

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

interface LiveState {
  exists: boolean | null;
  status: string | null;
  checkedAt: string;
  error: string | null;
}

interface InstanceDetail {
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
          disabled={acting !== null || isRunning}
          title={isRunning ? "Already running" : "Start"}
        >
          {acting === "start" ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Power className="h-4 w-4" aria-hidden="true" />}
          {compact ? null : "Start"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void act("stop")}
          disabled={acting !== null || isStopped}
          title={isStopped ? "Already stopped" : "Stop"}
        >
          {acting === "stop" ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Square className="h-4 w-4" aria-hidden="true" />}
          {compact ? null : "Stop"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void act("restart")}
          disabled={acting !== null || unknown}
          title="Restart"
        >
          {acting === "restart" ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-4 w-4" aria-hidden="true" />}
          {compact ? null : "Restart"}
        </Button>
      </div>
      {unknown && !compact ? (
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

function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 break-words text-sm text-primary ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  );
}

function OverviewTab({ detail, onRefresh }: { detail: InstanceDetail; onRefresh: () => void }) {
  const [metrics, setMetrics] = React.useState<{ cpuSeconds: number | null; memoryMb: number | null } | null>(null);
  const running = detail.live.exists === true && detail.live.status === "running";

  React.useEffect(() => {
    let cancelled = false;
    if (!running) {
      setMetrics(null);
      return;
    }
    api
      .get<{ live: LiveState; metrics: { cpuSeconds: number | null; memoryMb: number | null } | null }>(
        `/api/instances/${detail.instance.id}/live`
      )
      .then((d) => {
        if (!cancelled) setMetrics(d.metrics);
      })
      .catch(() => {
        if (!cancelled) setMetrics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detail.instance.id, running, detail.live.checkedAt]);

  const i = detail.instance;
  return (
    <div className="flex flex-col gap-5">
      {detail.live.exists === false ? (
        <InlineAlert message={detail.live.error ?? "Container not found on the host. The database record may be stale."} />
      ) : null}
      {detail.live.exists === null ? (
        <InlineAlert message={detail.live.error ?? "Live host state is currently unavailable."} />
      ) : null}
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
        {!running ? (
          <p className="text-sm text-muted">Unavailable — the container is not running.</p>
        ) : !metrics ? (
          <p className="text-sm text-muted" role="status">Reading live metrics…</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Fact label="CPU time used" value={metrics.cpuSeconds !== null ? `${metrics.cpuSeconds} s` : "Unavailable"} />
            <Fact label="Memory in use" value={metrics.memoryMb !== null ? `${metrics.memoryMb} MB` : "Unavailable"} />
          </div>
        )}
        <p className="mt-3 text-xs text-muted">Configured limits above are enforced by the host; live values are reported by LXC.</p>
      </Card>
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-primary">Power</h2>
        <PowerControls detail={detail} onDone={onRefresh} />
      </Card>
    </div>
  );
}

type ConsolePhase = "checking" | "ready" | "unsupported" | "connecting" | "open" | "closed" | "error";

function ConsoleTab({ instanceId }: { instanceId: string }) {
  const [phase, setPhase] = React.useState<ConsolePhase>("checking");
  const [reason, setReason] = React.useState<string>("");
  const [detail, setDetail] = React.useState<string>("");
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const sessionRef = React.useRef<{ term: Terminal; ws: WebSocket } | null>(null);

  const disconnect = React.useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = null;
    try {
      s?.ws.close(1000, "client disconnect");
    } catch {
      /* ignore */
    }
    try {
      s?.term.dispose();
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<{ supported: boolean; running: boolean; reason: string | null }>(`/api/instances/${instanceId}/console`)
      .then((d) => {
        if (cancelled) return;
        if (d.supported) {
          setPhase("ready");
        } else {
          setPhase("unsupported");
          setReason(d.reason ?? "Console unavailable.");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase("error");
        setDetail(err instanceof ApiError ? err.message : "Could not check console availability.");
      });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [instanceId, disconnect]);

  const connect = (): void => {
    if (!boxRef.current || sessionRef.current) return;
    setPhase("connecting");
    setDetail("");
    // xterm is loaded on demand so the main bundle stays lean.
    void (async () => {
      let TerminalCtor: typeof import("@xterm/xterm").Terminal;
      let FitAddonCtor: typeof import("@xterm/addon-fit").FitAddon;
      try {
        const xterm = await import("@xterm/xterm");
        const fitAddon = await import("@xterm/addon-fit");
        await import("@xterm/xterm/css/xterm.css");
        TerminalCtor = xterm.Terminal;
        FitAddonCtor = fitAddon.FitAddon;
      } catch {
        setPhase("error");
        setDetail("Could not load the terminal component.");
        return;
      }
      if (!boxRef.current || sessionRef.current) return;
      const term = new TerminalCtor({
        cursorBlink: true,
        fontSize: 14,
        theme: {
          background: "#000000",
          foreground: "#F5F5F5",
          cursor: "#F5F5F5",
          selectionBackground: "#303030",
        },
      });
      const fit = new FitAddonCtor();
      term.loadAddon(fit);
      term.open(boxRef.current);
      fit.fit();
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/instances/${instanceId}/console`);
    sessionRef.current = { term, ws };
    ws.onopen = () => {
      setPhase("open");
      fit.fit();
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (ev: MessageEvent) => {
      let msg: { type?: string; data?: string; message?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "output" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "error") {
        setDetail(msg.message ?? "Console error.");
      } else if (msg.type === "exit") {
        setPhase("closed");
        setDetail("Session ended.");
      }
    };
    const onEnd = (): void => {
      if (sessionRef.current) {
        sessionRef.current = null;
        try {
          term.dispose();
        } catch {
          /* ignore */
        }
      }
      setPhase((p) => (p === "open" ? "closed" : p));
    };
    ws.onclose = onEnd;
    ws.onerror = () => {
      setDetail("Connection failed. The container may have stopped or the session was rejected.");
    };
    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    })();
  };

  return (
    <Card>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-primary">
        <TerminalIcon className="h-4 w-4" aria-hidden="true" /> Container console
      </h2>
      <p className="mb-4 text-xs text-muted">Attached to the container only — never the host shell. Sessions end after 15 minutes idle.</p>
      {phase === "checking" ? <p className="text-sm text-muted" role="status">Checking console availability…</p> : null}
      {phase === "unsupported" ? (
        <EmptyState title="Console unavailable" hint={reason} />
      ) : null}
      {phase === "error" ? <InlineAlert message={detail} /> : null}
      {phase === "ready" || phase === "connecting" || phase === "open" || phase === "closed" ? (
        <div className="flex flex-col gap-3">
          {(phase === "ready" || phase === "closed") && (
            <div>
              <Button type="button" onClick={connect}>
                {phase === "closed" ? "Reconnect" : "Connect"}
              </Button>
            </div>
          )}
          {phase === "connecting" ? <p className="text-sm text-muted" role="status">Connecting…</p> : null}
          {phase === "open" && (
            <Button type="button" variant="ghost" onClick={() => { disconnect(); setPhase("closed"); }}>
              Disconnect
            </Button>
          )}
          <InlineAlert message={detail || undefined} />
          <div ref={boxRef} className="min-h-[320px] overflow-hidden rounded-md border border-border bg-black" aria-label="Container terminal" />
        </div>
      ) : null}
    </Card>
  );
}

function ResourcesTab({ detail, onRefresh }: { detail: InstanceDetail; onRefresh: () => void }) {
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
                  <td className="text-muted">{config.configured.cpu} vCPU</td>
                  <td className="text-muted">{config.effective.cpu !== null ? `${config.effective.cpu} vCPU (cgroup ${config.effective.cgroupVersion})` : "Unavailable"}</td>
                </tr>
                <tr>
                  <td className="text-primary">CPU visibility</td>
                  <td className="text-muted">{config.configured.cpu} vCPU</td>
                  <td className="text-muted">
                    {config.effective.cpuset !== null
                      ? `cpuset ${config.effective.cpuset} (${config.effective.cpusetCpus ?? "?"} visible) — shared set, not dedicated cores`
                      : "Unavailable"}
                  </td>
                </tr>
                <tr>
                  <td className="text-primary">Memory</td>
                  <td className="text-muted">{config.configured.memory_mb} MB</td>
                  <td className="text-muted">{config.effective.memoryMb !== null ? `${config.effective.memoryMb} MB (cgroup ${config.effective.cgroupVersion})` : "Unavailable"}</td>
                </tr>
                <tr>
                  <td className="text-primary">Disk</td>
                  <td className="text-muted">{config.configured.storage_gb} GB (recorded)</td>
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
                    {config.lxcfs === null ? "Unavailable" : config.lxcfs.active ? "Active in guest" : "Not mounted in guest"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mb-1 text-sm font-semibold text-primary">Change limits</h2>
        <p className="mb-4 text-xs text-muted">CPU and memory are enforced through cgroup limits{config ? ` (${config.effective.cgroupVersion})` : ""} and applied live when the container runs. {diskEditable ? "Disk quota is enforceable on this backend and can be changed below." : "Disk quotas are not enforceable on this backend."}</p>
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
      </Card>
      <RepairCard instanceId={i.id} onRepaired={() => { void loadConfig(); onRefresh(); }} />
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

function RepairCard({ instanceId, onRepaired }: { instanceId: string; onRepaired: () => void }): React.JSX.Element {
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

function NetworkTab({ detail }: { detail: InstanceDetail }) {
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
        state: string;
        pid: number | null;
        ipv4: string[];
        ipv6: string[];
        links: string[];
        bridge: string | null;
      }>(`/api/instances/${detail.instance.id}/network`)
      .then((d) => {
        if (!cancelled) {
          setNetwork(d);
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
          <Fact label="State" value={network.state} />
          <Fact label="Bridge" value={network.bridge ?? "Unavailable"} mono />
          <Fact label="IPv4" value={network.ipv4.length > 0 ? network.ipv4.join(", ") : "None reported"} mono />
          <Fact label="IPv6" value={network.ipv6.length > 0 ? network.ipv6.join(", ") : "None reported"} mono />
          <Fact label="Interfaces" value={network.links.length > 0 ? network.links.join(", ") : "Unavailable"} mono />
          <Fact label="Host PID" value={network.pid !== null ? String(network.pid) : "—"} />
        </div>
      )}
      {!loading && network && network.ipv4.length === 0 && network.ipv6.length === 0 ? (
        <p className="mt-3 text-xs text-muted">No address reported — the container is likely stopped, or DHCP on the bridge has not assigned one yet.</p>
      ) : null}
    </Card>
  );
}

function SettingsTab({ detail, onRefresh }: { detail: InstanceDetail; onRefresh: () => void }) {
  const navigate = useNavigate();
  const i = detail.instance;
  const [name, setName] = React.useState(i.name);
  const [error, setError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();
  const [saving, setSaving] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

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
      navigate("/");
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
    </div>
  );
}

type TabId = "overview" | "console" | "resources" | "network" | "settings";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "console", label: "Console" },
  { id: "resources", label: "Resources" },
  { id: "network", label: "Network" },
  { id: "settings", label: "Settings" },
];

export function InstanceDetailsPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = React.useState<TabId>("overview");
  const { detail, error, loading, load } = useInstance(id);

  const refresh = React.useCallback(() => {
    void load();
  }, [load]);

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
                onClick={() => setTab(t.id)}
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
            {tab === "overview" && <OverviewTab detail={detail} onRefresh={refresh} />}
            {tab === "console" && <ConsoleTab instanceId={detail.instance.id} />}
            {tab === "resources" && <ResourcesTab detail={detail} onRefresh={refresh} />}
            {tab === "network" && <NetworkTab detail={detail} />}
            {tab === "settings" && <SettingsTab detail={detail} onRefresh={refresh} />}
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
