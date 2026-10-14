import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Search, Server } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { avatarDataUri } from "@/lib/avatar";
import {
  Button,
  EmptyState,
  InlineAlert,
  Input,
  Label,
  PageHeader,
  StatusBadge,
} from "@/components/ui/primitives";
import { formatDateTime } from "@/pages/InstanceDetails";
import { cn } from "@/lib/utils";

interface LiveState {
  exists: boolean | null;
  status: string | null;
  checkedAt: string;
  error: string | null;
}

interface AdminInstance {
  id: string;
  name: string;
  container_id: string;
  node_id: string | null;
  node_name: string | null;
  status: string;
  cpu: number;
  memory_mb: number;
  storage_gb: number;
  template: string | null;
  created_at: string;
  updated_at: string;
  owner_id: string;
  owner: {
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    avatar_seed: string;
  } | null;
  node: { id: string; name: string; endpoint: string; status: string } | null;
  live: LiveState;
}

interface InstanceStats {
  total: number;
  running: number;
  stopped: number;
  transitional: number;
  failed: number;
  unknown: number;
  other: number;
  missing_owner: number;
  missing_node: number;
  unattached_node: number;
  node_degraded: number;
}

interface Pagination {
  page: number;
  page_size: number;
  total: number;
  pages: number;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "stopped", label: "Stopped" },
  { value: "transitional", label: "Starting or stopping" },
  { value: "failed", label: "Failed" },
  { value: "unknown", label: "Unknown" },
  { value: "missing", label: "Missing container" },
  { value: "unavailable", label: "Host state unavailable" },
];

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "created_desc", label: "Newest first" },
  { value: "created_asc", label: "Oldest first" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
  { value: "status_asc", label: "Status" },
];

function StatusCell({ instance }: { instance: AdminInstance }): React.JSX.Element {
  const { live } = instance;
  if (live.exists === false) {
    return (
      <span title={live.error ?? "Container not found on the host."}>
        <StatusBadge status="missing" />
      </span>
    );
  }
  if (live.exists === null) {
    return (
      <span title={live.error ?? "Host state could not be checked."}>
        <StatusBadge status="unavailable" />
      </span>
    );
  }
  return <StatusBadge status={live.status ?? instance.status} />;
}

function Stat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="kct-card px-4 py-3">
      <p className="text-2xl font-semibold tracking-tight text-primary">{value}</p>
      <p className="mt-0.5 text-xs text-muted">{label}</p>
    </div>
  );
}

export function AdminInstancesPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const appliedQuery = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const nodeId = params.get("node_id") ?? "";
  const ownerId = params.get("owner_id") ?? "";
  const template = params.get("template") ?? "";
  const sortValue = params.get("sort") ?? "created_desc";

  const [searchInput, setSearchInput] = React.useState(appliedQuery);
  React.useEffect(() => setSearchInput(appliedQuery), [appliedQuery]);

  const [instances, setInstances] = React.useState<AdminInstance[] | null>(null);
  const [pagination, setPagination] = React.useState<Pagination | null>(null);
  const [stats, setStats] = React.useState<InstanceStats | null>(null);
  const [nodes, setNodes] = React.useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = React.useState<{ id: string; name: string; email: string }[]>([]);
  const [templates, setTemplates] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(true);

  const updateParams = React.useCallback(
    (patch: Record<string, string>, resetPage = true) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (resetPage) next.delete("page");
      setParams(next, { replace: false });
    },
    [params, setParams]
  );

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const query = new URLSearchParams();
    query.set("page", String(page));
    query.set("page_size", "25");
    if (appliedQuery) query.set("q", appliedQuery);
    if (status) query.set("status", status);
    if (nodeId) query.set("node_id", nodeId);
    if (ownerId) query.set("owner_id", ownerId);
    if (template) query.set("template", template);
    const [sort, order] = sortValue.split("_");
    query.set("sort", sort === "created" ? "created_at" : sort);
    query.set("order", order ?? "desc");
    api
      .get<{ instances: AdminInstance[]; pagination: Pagination }>(`/api/admin/instances?${query.toString()}`)
      .then((d) => {
        if (cancelled) return;
        setInstances(d.instances);
        setPagination(d.pagination);
        setError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Unable to load instances.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, appliedQuery, status, nodeId, ownerId, template, sortValue]);

  React.useEffect(() => {
    api
      .get<{ stats: InstanceStats }>("/api/admin/instances/stats")
      .then((d) => setStats(d.stats))
      .catch(() => undefined);
    api
      .get<{ nodes: { id: string; name: string }[] }>("/api/nodes")
      .then((d) => setNodes(d.nodes))
      .catch(() => undefined);
    api
      .get<{ users: { id: string; name: string; email: string }[] }>("/api/admin/users?page=1&page_size=100")
      .then((d) => setUsers(d.users))
      .catch(() => undefined);
    api
      .get<{ templates: string[] }>("/api/templates")
      .then((d) => setTemplates(d.templates))
      .catch(() => undefined);
  }, []);

  const integrityFlags: string[] = [];
  if (stats) {
    if (stats.missing_owner > 0) integrityFlags.push(`${stats.missing_owner} without a valid owner`);
    if (stats.missing_node > 0) integrityFlags.push(`${stats.missing_node} on an unregistered node`);
    if (stats.unattached_node > 0) integrityFlags.push(`${stats.unattached_node} not attached to any node`);
    if (stats.node_degraded > 0) integrityFlags.push(`${stats.node_degraded} on a node whose last check failed`);
  }

  return (
    <div>
      <PageHeader
        title="Instances"
        subtitle="View and manage all virtual servers across your KineticCT installation."
        actions={
          <Link to="/admin/create" className="kct-btn-ghost inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold">
            <Server className="h-4 w-4" aria-hidden="true" /> Create VPS
          </Link>
        }
      />
      <InlineAlert message={error} />

      {stats ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-label="Instance statistics">
          <Stat label="Total managed" value={stats.total} />
          <Stat label="Running (recorded)" value={stats.running} />
          <Stat label="Stopped (recorded)" value={stats.stopped} />
          <Stat label="Starting / stopping" value={stats.transitional} />
          <Stat label="Failed" value={stats.failed} />
          <Stat label="Unknown" value={stats.unknown + stats.other} />
        </div>
      ) : null}
      {integrityFlags.length > 0 ? (
        <div role="status" className="mb-4 flex items-start gap-2 rounded-md border border-mid bg-raised px-3 py-2 text-sm text-primary">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Inventory needs attention: {integrityFlags.join(" · ")}. Live host state is verified per instance.</span>
        </div>
      ) : null}

      <form
        role="search"
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          updateParams({ q: searchInput.trim() });
        }}
      >
        <div className="min-w-52 flex-1">
          <Label htmlFor="instances-q">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input
              id="instances-q"
              className="pl-9"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Name, container, ID, owner…"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="instances-status">Status</Label>
          <select id="instances-status" className="kct-input" value={status} onChange={(e) => updateParams({ status: e.target.value })}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="instances-node">Node</Label>
          <select id="instances-node" className="kct-input" value={nodeId} onChange={(e) => updateParams({ node_id: e.target.value })}>
            <option value="">All nodes</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="instances-owner">Owner</Label>
          <select id="instances-owner" className="kct-input" value={ownerId} onChange={(e) => updateParams({ owner_id: e.target.value })}>
            <option value="">All owners</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="instances-template">OS template</Label>
          <select id="instances-template" className="kct-input" value={template} onChange={(e) => updateParams({ template: e.target.value })}>
            <option value="">All templates</option>
            {templates.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="instances-sort">Sort</Label>
          <select id="instances-sort" className="kct-input" value={sortValue} onChange={(e) => updateParams({ sort: e.target.value })}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit">Search</Button>
      </form>

      {loading && instances === null ? (
        <p className="text-sm text-muted" role="status">
          Loading instances…
        </p>
      ) : instances && instances.length === 0 ? (
        <EmptyState
          title="No instances match"
          hint="Try widening the search or clearing a filter. Records are read from the live database — nothing is hidden."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="kct-table kct-card w-full min-w-[1080px] border-collapse overflow-hidden">
            <thead>
              <tr>
                <th scope="col">VPS</th>
                <th scope="col">Owner</th>
                <th scope="col">Status</th>
                <th scope="col">Node</th>
                <th scope="col">CPU</th>
                <th scope="col">RAM</th>
                <th scope="col">Storage</th>
                <th scope="col">Operating system</th>
                <th scope="col">Created</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(instances ?? []).map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link to={`/admin/instances/${i.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                      {i.name}
                    </Link>
                    <span className="block font-mono text-xs text-muted" title={`Instance ${i.id} · container ${i.container_id}`}>
                      {i.container_id}
                    </span>
                  </td>
                  <td>
                    {i.owner ? (
                      <Link to={`/admin/users/${i.owner.id}`} className="flex items-center gap-2 hover:underline">
                        <img
                          src={avatarDataUri(i.owner.avatar_seed || i.owner.email)}
                          alt=""
                          aria-hidden="true"
                          className="h-6 w-6 shrink-0 rounded-full"
                        />
                        <span>
                          <span className="block text-sm text-primary">{i.owner.name}</span>
                          <span className="block text-xs text-muted">{i.owner.email}</span>
                        </span>
                      </Link>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-sm text-muted" title={`Owner record for ${i.owner_id} is missing`}>
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Unassigned
                      </span>
                    )}
                  </td>
                  <td>
                    <StatusCell instance={i} />
                  </td>
                  <td className="text-muted">{i.node ? i.node.name : "—"}</td>
                  <td className="text-muted">{i.cpu} vCPU</td>
                  <td className="text-muted">{i.memory_mb} MB</td>
                  <td className="text-muted">{i.storage_gb} GB</td>
                  <td className="text-muted">{i.template ?? "—"}</td>
                  <td className={cn("whitespace-nowrap text-muted")}>{formatDateTime(i.created_at)}</td>
                  <td>
                    <Link to={`/admin/instances/${i.id}`} className="kct-btn-ghost inline-block px-3 py-1.5 text-xs">
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.pages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm text-muted">
          <span aria-live="polite">
            Page {pagination.page} of {pagination.pages} · {pagination.total} instance{pagination.total === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              disabled={page <= 1}
              onClick={() => updateParams({ page: String(page - 1) }, false)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              disabled={page >= pagination.pages}
              onClick={() => updateParams({ page: String(page + 1) }, false)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
      <p className="mt-4 text-xs text-muted">
        Status badges marked “Missing” were checked against the host and found absent; “Unavailable” means the host could
        not be reached and the record is left untouched.
      </p>
    </div>
  );
}
