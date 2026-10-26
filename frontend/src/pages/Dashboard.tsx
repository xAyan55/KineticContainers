import * as React from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  Check,
  Copy,
  Cpu,
  HardDrive,
  LayoutGrid,
  List,
  MemoryStick,
  Play,
  Power,
  RotateCcw,
  Search,
  Server,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { useAuth } from "@/features/auth/AuthContext";
import { ApiError, api, type Instance } from "@/lib/api";
import { Card, EmptyState, InlineAlert, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function formatMemory(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

type ViewMode = "cards" | "table";
type StatusFilter = "all" | "running" | "stopped" | "suspended";

export function DashboardPage(): React.JSX.Element {
  const { user } = useAuth();
  const [instances, setInstances] = React.useState<Instance[] | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [acting, setActing] = React.useState<{ id: string; action: "start" | "stop" | "restart" } | null>(null);
  const [feedback, setFeedback] = React.useState<string | undefined>();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState<Date>(new Date());
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  const [viewMode, setViewMode] = React.useState<ViewMode>(() => {
    try {
      const saved = window.localStorage.getItem("kineticct.dashboard.viewMode");
      if (saved === "table" || saved === "cards") return saved;
    } catch {
      /* ignore */
    }
    return "cards";
  });

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem("kineticct.dashboard.viewMode", mode);
    } catch {
      /* ignore */
    }
  };

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setIsRefreshing(true);
    try {
      const data = await api.get<{ instances: Instance[] }>("/api/instances");
      setInstances(data.instances);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load instances.");
    } finally {
      if (!silent) setIsRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const copyText = (text: string, identifier: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(identifier);
    setTimeout(() => {
      setCopiedId((curr) => (curr === identifier ? null : curr));
    }, 1800);
  };

  const act = async (instance: Instance, action: "start" | "stop" | "restart"): Promise<void> => {
    setActing({ id: instance.id, action });
    setError(undefined);
    setFeedback(undefined);
    try {
      await api.post(`/api/instances/${instance.id}/actions`, { action });
      setFeedback(`Sent ${action} command to ${instance.name}.`);
      setTimeout(() => setFeedback(undefined), 4000);
      await load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} instance.`);
    } finally {
      setActing(null);
    }
  };

  const stats = React.useMemo(() => {
    if (!instances) return { total: 0, running: 0, stopped: 0, suspended: 0, cpu: 0, memoryMb: 0, storageGb: 0 };
    return {
      total: instances.length,
      running: instances.filter((i) => i.status === "running").length,
      stopped: instances.filter((i) => i.status === "stopped").length,
      suspended: instances.filter((i) => i.status === "suspended").length,
      cpu: instances.reduce((acc, i) => acc + (Number(i.cpu) || 0), 0),
      memoryMb: instances.reduce((acc, i) => acc + (Number(i.memory_mb) || 0), 0),
      storageGb: instances.reduce((acc, i) => acc + (Number(i.storage_gb) || 0), 0),
    };
  }, [instances]);

  const filteredInstances = React.useMemo(() => {
    if (!instances) return [];
    return instances.filter((i) => {
      if (statusFilter !== "all" && i.status !== statusFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        i.name.toLowerCase().includes(q) ||
        i.container_id.toLowerCase().includes(q) ||
        (i.node_name && i.node_name.toLowerCase().includes(q)) ||
        (i.template && i.template.toLowerCase().includes(q)) ||
        (i.ip_address && i.ip_address.toLowerCase().includes(q))
      );
    });
  }, [instances, statusFilter, searchQuery]);

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header */}
      <PageHeader
        title="Dashboard"
        subtitle={user ? `Welcome back, ${user.name}. Overview of your assigned virtual servers.` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={isRefreshing}
              title={`Last refreshed at ${lastRefreshed.toLocaleTimeString()}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:border-highlight hover:bg-raised hover:text-primary transition-all disabled:opacity-50"
            >
              <RotateCcw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin text-primary")} aria-hidden="true" />
              <span className="hidden sm:inline">{isRefreshing ? "Refreshing…" : "Refresh"}</span>
            </button>
          </div>
        }
      />

      <InlineAlert message={error} />

      {feedback ? (
        <div role="status" className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-300">
          <span className="flex items-center gap-2">
            <Check className="h-4 w-4" aria-hidden="true" />
            {feedback}
          </span>
          <button type="button" onClick={() => setFeedback(undefined)} className="text-emerald-400 hover:text-white">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {/* KPI Overview Strip */}
      {instances && instances.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="kct-card flex flex-col justify-between p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Instances</span>
              <Server className="h-4 w-4 text-muted" aria-hidden="true" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold tracking-tight text-primary">{stats.total}</span>
              <span className="text-xs text-muted">total</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span>{stats.running} running</span>
              <span className="text-mid">·</span>
              <span>{stats.stopped} stopped</span>
            </div>
          </div>

          <div className="kct-card flex flex-col justify-between p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">vCPU Power</span>
              <Cpu className="h-4 w-4 text-muted" aria-hidden="true" />
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="font-mono text-2xl font-bold tracking-tight text-primary">{stats.cpu}</span>
              <span className="text-xs text-muted">cores</span>
            </div>
            <p className="mt-1 text-xs text-muted">Allocated compute cores</p>
          </div>

          <div className="kct-card flex flex-col justify-between p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Memory</span>
              <MemoryStick className="h-4 w-4 text-muted" aria-hidden="true" />
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="font-mono text-2xl font-bold tracking-tight text-primary">{formatMemory(stats.memoryMb)}</span>
            </div>
            <p className="mt-1 text-xs text-muted">Allocated RAM footprint</p>
          </div>

          <div className="kct-card flex flex-col justify-between p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Storage</span>
              <HardDrive className="h-4 w-4 text-muted" aria-hidden="true" />
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="font-mono text-2xl font-bold tracking-tight text-primary">{stats.storageGb}</span>
              <span className="text-xs text-muted">GB</span>
            </div>
            <p className="mt-1 text-xs text-muted">Configured root storage</p>
          </div>
        </div>
      ) : null}

      {/* Main Content Area */}
      {instances === null && !error ? (
        <div className="kct-card flex items-center justify-center p-12 text-sm text-muted">
          <RotateCcw className="mr-2 h-4 w-4 animate-spin" />
          Loading instances…
        </div>
      ) : instances && instances.length === 0 ? (
        <EmptyState
          title="No instances assigned"
          hint="No virtual servers are currently assigned to your account. Contact your administrator if you expected to see servers here."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Controls Bar: Search, Status Filter, View Toggle */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Search Input */}
            <div className="relative w-full min-w-0 sm:w-auto sm:min-w-[220px] sm:max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search instances by name, ID, node…"
                className="kct-input !pl-9 pr-8 text-xs"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-primary"
                  title="Clear search"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>

            {/* Filter Pills & View Mode Switch */}
            <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
              {/* Status Filter Tabs */}
              <div role="tablist" aria-label="Filter by status" className="inline-flex max-w-full overflow-x-auto rounded-lg border border-border bg-surface p-0.5">
                {(["all", "running", "stopped", "suspended"] as const).map((filter) => {
                  const count =
                    filter === "all"
                      ? instances?.length ?? 0
                      : instances?.filter((i) => i.status === filter).length ?? 0;
                  if (filter === "suspended" && count === 0) return null;
                  const isActive = statusFilter === filter;
                  return (
                    <button
                      key={filter}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setStatusFilter(filter)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all capitalize",
                        isActive
                          ? "bg-raised text-primary shadow-sm"
                          : "text-muted hover:text-primary"
                      )}
                    >
                      {filter === "running" && (
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                      )}
                      {filter === "stopped" && (
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" aria-hidden="true" />
                      )}
                      <span>{filter}</span>
                      <span className="text-[0.65rem] opacity-60 font-mono">({count})</span>
                    </button>
                  );
                })}
              </div>

              {/* View Switcher: Cards vs Table */}
              <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
                <button
                  type="button"
                  onClick={() => changeViewMode("cards")}
                  title="Grid view"
                  aria-label="Grid view"
                  className={cn(
                    "rounded-md p-1.5 text-muted transition-colors",
                    viewMode === "cards" ? "bg-raised text-primary shadow-sm" : "hover:text-primary"
                  )}
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => changeViewMode("table")}
                  title="Table view"
                  aria-label="Table view"
                  className={cn(
                    "rounded-md p-1.5 text-muted transition-colors",
                    viewMode === "table" ? "bg-raised text-primary shadow-sm" : "hover:text-primary"
                  )}
                >
                  <List className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Results Counter if searching/filtered */}
          {(searchQuery || statusFilter !== "all") && (
            <div className="flex items-center justify-between text-xs text-muted">
              <span>
                Showing {filteredInstances.length} of {instances?.length ?? 0} instances
              </span>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  setStatusFilter("all");
                }}
                className="underline hover:text-primary"
              >
                Reset filters
              </button>
            </div>
          )}

          {/* Empty search results */}
          {filteredInstances.length === 0 ? (
            <div className="kct-card flex flex-col items-center gap-2 px-6 py-12 text-center">
              <Server className="h-8 w-8 text-muted opacity-50" />
              <p className="text-sm font-semibold text-primary">No instances found</p>
              <p className="text-xs text-muted">No servers match your current filter or search query.</p>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  setStatusFilter("all");
                }}
                className="mt-2 text-xs font-medium text-primary underline underline-offset-4"
              >
                Clear search query
              </button>
            </div>
          ) : viewMode === "cards" ? (
            /* ============================================================== */
            /* Modern Minimalist Cards View                                  */
            /* ============================================================== */
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredInstances.map((i) => {
                const isActingThis = acting?.id === i.id;
                const isStarting = isActingThis && acting?.action === "start";
                const isStopping = isActingThis && acting?.action === "stop";
                const isRestarting = isActingThis && acting?.action === "restart";
                const isSuspended = i.status === "suspended";

                return (
                  <div
                    key={i.id}
                    className="kct-card kct-card-interactive group flex flex-col justify-between overflow-hidden p-5"
                  >
                    <div>
                      {/* Top Bar: Title & Status */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <Link
                            to={`/instances/${i.id}`}
                            className="truncate text-base font-semibold text-primary hover:text-white transition-colors"
                          >
                            {i.name}
                          </Link>
                          {/* Container ID with 1-click copy */}
                          <div className="mt-1 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => copyText(i.container_id, `cid-${i.id}`)}
                              title="Click to copy container ID"
                              className="group/copy inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-primary transition-colors"
                            >
                              <span>{i.container_id}</span>
                              {copiedId === `cid-${i.id}` ? (
                                <Check className="h-3 w-3 text-emerald-400" />
                              ) : (
                                <Copy className="h-3 w-3 opacity-0 group-hover/copy:opacity-100 transition-opacity" />
                              )}
                            </button>
                          </div>
                        </div>

                        <StatusBadge status={i.status} />
                      </div>

                      {/* Meta Tags: Template & Node & IP */}
                      <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
                        {i.template ? (
                          <span className="rounded bg-surface px-2 py-0.5 font-mono text-[0.7rem] text-muted border border-border">
                            {i.template}
                          </span>
                        ) : null}

                        {i.node_name ? (
                          <span className="rounded bg-surface px-2 py-0.5 text-[0.7rem] text-muted border border-border">
                            {i.node_name}
                          </span>
                        ) : null}

                        {i.ip_address ? (
                          <button
                            type="button"
                            onClick={() => copyText(i.ip_address!, `ip-${i.id}`)}
                            title="Click to copy IP"
                            className="inline-flex items-center gap-1 rounded bg-surface px-2 py-0.5 font-mono text-[0.7rem] text-muted border border-border hover:text-primary transition-colors"
                          >
                            <span>{i.ip_address}</span>
                            {copiedId === `ip-${i.id}` ? (
                              <Check className="h-2.5 w-2.5 text-emerald-400" />
                            ) : null}
                          </button>
                        ) : null}
                      </div>

                      {/* Resource Allocation Gauges */}
                      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
                        <div className="flex flex-col">
                          <span className="text-[0.68rem] uppercase tracking-wider text-muted font-medium">vCPU</span>
                          <span className="font-mono text-xs font-semibold text-primary">{i.cpu} core</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[0.68rem] uppercase tracking-wider text-muted font-medium">RAM</span>
                          <span className="font-mono text-xs font-semibold text-primary">{formatMemory(i.memory_mb)}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[0.68rem] uppercase tracking-wider text-muted font-medium">Disk</span>
                          <span className="font-mono text-xs font-semibold text-primary">{i.storage_gb} GB</span>
                        </div>
                      </div>
                    </div>

                    {/* Bottom Action Bar */}
                    <div className="mt-5 flex items-center justify-between border-t border-border/60 pt-3 gap-2">
                      <div className="flex items-center gap-1.5">
                        {/* 1-Click Console Shortcut */}
                        <Link
                          to={`/instances/${i.id}/console`}
                          title="Open Container Terminal"
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:border-highlight hover:bg-raised hover:text-primary transition-all"
                        >
                          <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="hidden sm:inline">Console</span>
                        </Link>

                        {/* Power Control Buttons */}
                        {i.status === "running" ? (
                          <>
                            <button
                              type="button"
                              disabled={acting !== null || isSuspended}
                              onClick={() => void act(i, "restart")}
                              title="Restart container"
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface p-1.5 text-xs text-muted hover:border-highlight hover:bg-raised hover:text-primary transition-all disabled:opacity-50"
                            >
                              <RotateCcw className={cn("h-3.5 w-3.5", isRestarting && "animate-spin text-amber-400")} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              disabled={acting !== null || isSuspended}
                              onClick={() => void act(i, "stop")}
                              title="Stop container"
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface p-1.5 text-xs text-muted hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300 transition-all disabled:opacity-50"
                            >
                              {isStopping ? (
                                <RotateCcw className="h-3.5 w-3.5 animate-spin text-rose-400" />
                              ) : (
                                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={acting !== null || isSuspended}
                            onClick={() => void act(i, "start")}
                            title={isSuspended ? "Container suspended" : "Start container"}
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition-all disabled:opacity-50"
                          >
                            {isStarting ? (
                              <RotateCcw className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                            )}
                            <span>Start</span>
                          </button>
                        )}
                      </div>

                      {/* Manage Link */}
                      <Link
                        to={`/instances/${i.id}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-primary transition-colors"
                      >
                        <span>Manage</span>
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* ============================================================== */
            /* Refined Minimalist Table View                                 */
            /* ============================================================== */
            <div className="overflow-x-auto">
              <table className="kct-table kct-card w-full min-w-[760px] border-collapse overflow-hidden">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Container</th>
                    <th scope="col">Status</th>
                    <th scope="col">Node</th>
                    <th scope="col">Resources</th>
                    <th scope="col">Template</th>
                    <th scope="col">Created</th>
                    <th scope="col" className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInstances.map((i) => {
                    const isActingThis = acting?.id === i.id;
                    const isStarting = isActingThis && acting?.action === "start";
                    const isStopping = isActingThis && acting?.action === "stop";
                    const isRestarting = isActingThis && acting?.action === "restart";
                    const isSuspended = i.status === "suspended";

                    return (
                      <tr key={i.id} className="group">
                        <td className="font-medium text-primary">
                          <Link to={`/instances/${i.id}`} className="hover:underline underline-offset-4">
                            {i.name}
                          </Link>
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => copyText(i.container_id, `cid-table-${i.id}`)}
                            title="Click to copy container ID"
                            className="group/copy inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-primary transition-colors"
                          >
                            <span>{i.container_id}</span>
                            {copiedId === `cid-table-${i.id}` ? (
                              <Check className="h-3 w-3 text-emerald-400" />
                            ) : (
                              <Copy className="h-3 w-3 opacity-0 group-hover/copy:opacity-100 transition-opacity" />
                            )}
                          </button>
                        </td>
                        <td>
                          <StatusBadge status={i.status} />
                        </td>
                        <td className="text-muted text-xs">{i.node_name ?? "—"}</td>
                        <td>
                          <div className="flex items-center gap-2 text-xs text-muted font-mono">
                            <span>{i.cpu} vCPU</span>
                            <span className="text-mid">·</span>
                            <span>{formatMemory(i.memory_mb)}</span>
                            <span className="text-mid">·</span>
                            <span>{i.storage_gb} GB</span>
                          </div>
                        </td>
                        <td className="text-muted text-xs font-mono">{i.template ?? "—"}</td>
                        <td className="text-muted text-xs">{formatDate(i.created_at)}</td>
                        <td>
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Console shortcut */}
                            <Link
                              to={`/instances/${i.id}/console`}
                              aria-label={`Open console for ${i.name}`}
                              title="Console"
                              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:border-highlight hover:bg-raised hover:text-primary transition-colors"
                            >
                              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                              <span className="hidden xl:inline">Console</span>
                            </Link>

                            {/* Power Controls */}
                            {i.status === "running" ? (
                              <>
                                <button
                                  type="button"
                                  disabled={acting !== null || isSuspended}
                                  onClick={() => void act(i, "restart")}
                                  aria-label={`Restart ${i.name}`}
                                  title="Restart"
                                  className="rounded border border-border p-1 text-muted hover:border-highlight hover:bg-raised hover:text-primary transition-colors disabled:opacity-50"
                                >
                                  <RotateCcw className={cn("h-3.5 w-3.5", isRestarting && "animate-spin text-amber-400")} aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  disabled={acting !== null || isSuspended}
                                  onClick={() => void act(i, "stop")}
                                  aria-label={`Stop ${i.name}`}
                                  title="Stop"
                                  className="rounded border border-border px-2 py-1 text-xs text-muted hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300 transition-colors disabled:opacity-50"
                                >
                                  {isStopping ? "Stopping…" : "Stop"}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={acting !== null || isSuspended}
                                onClick={() => void act(i, "start")}
                                aria-label={`Start ${i.name}`}
                                title={isSuspended ? "Suspended" : "Start"}
                                className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                              >
                                {isStarting ? (
                                  <RotateCcw className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Play className="h-3 w-3 fill-current" aria-hidden="true" />
                                )}
                                <span>Start</span>
                              </button>
                            )}

                            {/* Manage Link */}
                            <Link
                              to={`/instances/${i.id}`}
                              aria-label={`Manage ${i.name}`}
                              title="Manage"
                              className="rounded border border-border px-2.5 py-1 text-xs font-medium text-primary hover:bg-raised transition-colors"
                            >
                              Manage
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-2 text-xs text-muted">
            Power actions run against the host integration.{" "}
            <Link to="/profile" className="underline hover:text-primary">
              Manage your profile
            </Link>{" "}
            for account settings and credentials.
          </p>
        </div>
      )}
    </div>
  );
}
