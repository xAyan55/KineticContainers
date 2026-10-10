import * as React from "react";
import { Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
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
import { cn } from "@/lib/utils";

interface NodeRecord {
  id: string;
  name: string;
  endpoint: string;
  node_type: string;
  provider: string;
  host_address: string | null;
  status: string;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error: string | null;
  is_protected: boolean;
  capabilities: string | null;
  managed_containers: number;
  created_at: string;
  updated_at: string;
}

interface NodeCapabilities {
  containersTotal?: number | null;
  containersRunning?: number | null;
  cpuPercent?: number | null;
  memoryUsedMb?: number | null;
  memoryTotalMb?: number | null;
  storageUsedGb?: number | null;
  storageTotalGb?: number | null;
  readiness?: HostCapabilities | null;
}

interface HostInfo {
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

interface HostCapabilities {
  lxcInstalled: boolean;
  lxcVersion: string | null;
  nestedGuest: string | null;
  restrictedGuest: boolean;
  userNamespaces: boolean | null;
  cgroup: string;
  bridgePresent: boolean | null;
  ipForwarding: boolean | null;
  runtimeUid: number | null;
}

interface NodeCheck {
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
  host: HostInfo | null;
  hostCapabilities?: HostCapabilities | null;
  containersTotal: number | null;
  containersRunning: number | null;
}

interface NodeContainer {
  containerId: string;
  name: string;
  status: string;
  ipv4?: string;
  managed: boolean;
  owner: { id: string; name: string; email: string } | null;
}

function parseCapabilities(raw: string | null): NodeCapabilities | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as NodeCapabilities;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function isStale(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t > 15 * 60 * 1000;
}

function unavailable(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Unavailable";
  return String(value);
}

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}): React.JSX.Element {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/70" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "kct-card relative max-h-[85vh] w-full overflow-y-auto p-5 outline-none",
          wide ? "max-w-3xl" : "max-w-lg"
        )}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-primary"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value, stale }: { label: string; value: string; stale?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 break-words text-sm text-primary">
        {value}
        {stale ? <span className="ml-1.5 text-xs text-muted">(stale)</span> : null}
      </p>
    </div>
  );
}

function NodeDetails({
  node,
  onClose,
  onChanged,
}: {
  node: NodeRecord;
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [check, setCheck] = React.useState<NodeCheck | null>(null);
  const [containers, setContainers] = React.useState<NodeContainer[] | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  const runCheck = React.useCallback(async () => {
    setChecking(true);
    setError(undefined);
    try {
      const res = await api.post<{ check: NodeCheck }>(`/api/nodes/${node.id}/check`);
      setCheck(res.check);
      try {
        const inv = await api.get<{ nodeId: string; checkedAt: string; containers: NodeContainer[] }>(
          `/api/nodes/${node.id}/containers`
        );
        setContainers(inv.containers);
      } catch {
        // Inventory is best-effort: the health result still stands on its own.
        setContainers((prev) => prev ?? []);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Health check failed.");
      // Even a failed check updates stored status — refresh the list view.
      onChanged();
    } finally {
      setChecking(false);
    }
  }, [node.id, onChanged]);

  React.useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const caps = parseCapabilities(node.capabilities);
  const host = check?.host ?? null;
  const stale = isStale(node.last_check_at);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={check?.status ?? node.status} />
        <span className="text-xs text-muted">Last check: {fmtTime(check?.checkedAt ?? node.last_check_at)}</span>
        <span className="flex-1" />
        <Button type="button" variant="ghost" onClick={() => void runCheck()} disabled={checking}>
          <RefreshCw className={cn("h-4 w-4", checking && "animate-spin")} aria-hidden="true" />
          {checking ? "Checking…" : "Refresh"}
        </Button>
      </div>
      <InlineAlert message={error} />
      {check && !check.ok ? <InlineAlert message={check.detail} /> : null}
      {!node.is_protected ? null : (
        <p className="text-xs text-muted">
          This node represents the panel host itself. Its display name can be changed, but its identity and provider
          configuration are fixed and it cannot be removed.
        </p>
      )}

      <section aria-label="General information">
        <h3 className="mb-2 text-sm font-semibold text-primary">General</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Stat label="Node name" value={node.name} />
          <Stat label="Identifier" value={node.id} />
          <Stat label="Type" value={node.node_type === "local" ? "Local" : "Remote"} />
          <Stat label="Provider" value={node.provider} />
          <Stat label="Hostname" value={unavailable(host?.hostname)} />
          <Stat
            label="Operating system"
            value={host?.osName ? `${host.osName}${host.osVersion ? ` ${host.osVersion}` : ""}` : "Unavailable"}
          />
          <Stat label="Kernel" value={unavailable(host?.kernel)} />
          <Stat label="Architecture" value={unavailable(host?.arch)} />
        </div>
      </section>

      <section aria-label="Resource information">
        <h3 className="mb-2 text-sm font-semibold text-primary">Resources (host-level)</h3>
        {host ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Stat
              label="Memory"
              value={`${host.memoryUsedMb.toLocaleString()} MB used of ${host.memoryTotalMb.toLocaleString()} MB total`}
            />
            <Stat
              label="CPU"
              value={`${host.cpuModel ?? "Unknown CPU"} · ${host.cpuCount} cores${host.cpuPercent !== null ? ` · ${host.cpuPercent}% busy` : ""}`}
            />
            <Stat
              label="CPU load (1 min)"
              value={host.load1 !== null ? String(host.load1) : "Unavailable"}
            />
            <Stat
              label="Root filesystem"
              value={
                host.rootTotalGb !== null
                  ? `${host.rootUsedGb} GB used of ${host.rootTotalGb} GB total (${host.rootAvailGb} GB available)`
                  : "Unavailable"
              }
            />
            <Stat
              label="Containers detected"
              value={
                check?.containersTotal !== null && check?.containersTotal !== undefined
                  ? `${check.containersTotal} total · ${check?.containersRunning ?? 0} running`
                  : caps?.containersTotal !== null && caps?.containersTotal !== undefined
                    ? `${caps.containersTotal} total · ${caps.containersRunning ?? 0} running`
                    : "Unavailable"
              }
              stale={!check && stale}
            />
            <Stat label="Managed by KineticCT" value={`${node.managed_containers} instance(s)`} />
          </div>
        ) : (
          <p className="text-sm text-muted">
            {checking ? "Collecting resource statistics…" : "Resource statistics are Unavailable."}
            {node.last_error && !checking ? ` Last error: ${node.last_error}` : null}
          </p>
        )}
      </section>

            <section aria-label="Host readiness">
        <h3 className="mb-2 text-sm font-semibold text-primary">Host readiness</h3>
        {(() => {
          const ready = check?.hostCapabilities ?? caps?.readiness ?? null;
          if (!ready) {
            return (
              <p className="text-sm text-muted">
                {checking ? "Collecting readiness…" : "No readiness data yet — press Refresh to collect it."}
              </p>
            );
          }
          const tri = (v: boolean | null): string => (v === null ? "Unavailable" : v ? "Yes" : "No");
          return (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Stat
                label="LXC tooling"
                value={ready.lxcInstalled ? `Installed${ready.lxcVersion ? ` (${ready.lxcVersion})` : ""}` : "Not installed"}
              />
              <Stat
                label="Environment"
                value={
                  ready.nestedGuest
                    ? `Nested (${ready.nestedGuest})${ready.restrictedGuest ? " — nesting likely blocked" : ""}`
                    : "Bare metal or VM"
                }
              />
              <Stat label="User namespaces" value={tri(ready.userNamespaces)} />
              <Stat label="Cgroup" value={ready.cgroup} />
              <Stat
                label="Container bridge"
                value={ready.bridgePresent === null ? "Unavailable" : ready.bridgePresent ? "Present" : "Absent"}
              />
              <Stat
                label="IP forwarding"
                value={ready.ipForwarding === null ? "Unavailable" : ready.ipForwarding ? "On" : "Off"}
              />
            </div>
          );
        })()}
      </section>

      <section aria-label="Container inventory">
        <h3 className="mb-2 text-sm font-semibold text-primary">Containers on this node</h3>        {containers === null ? (
          <p className="text-sm text-muted">{checking ? "Reading container inventory…" : "Inventory Unavailable."}</p>
        ) : containers.length === 0 ? (
          <EmptyState title="No containers detected" hint="The host integration reported no LXC containers on this node." />
        ) : (
          <div className="overflow-x-auto">
            <table className="kct-table w-full min-w-[560px] border-collapse">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Identifier</th>
                  <th scope="col">Status</th>
                  <th scope="col">Owner</th>
                </tr>
              </thead>
              <tbody>
                {containers.map((c) => (
                  <tr key={c.containerId}>
                    <td className="font-medium text-primary">{c.name}</td>
                    <td className="font-mono text-xs text-muted">{c.containerId}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="text-muted">
                      {c.owner ? (
                        <span>
                          <span className="text-primary">{c.owner.name}</span>
                          <span className="block text-xs">{c.owner.email}</span>
                        </span>
                      ) : (
                        "Unmanaged"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          Containers discovered on the host without a KineticCT record are shown as Unmanaged and are never assigned
          automatically.
        </p>
      </section>

      <div className="flex justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

export function AdminNodesPage(): React.JSX.Element {
  const [nodes, setNodes] = React.useState<NodeRecord[] | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();
  const [checkingId, setCheckingId] = React.useState<string | null>(null);
  const [detailsNode, setDetailsNode] = React.useState<NodeRecord | null>(null);
  const [editNode, setEditNode] = React.useState<NodeRecord | null>(null);
  const [editName, setEditName] = React.useState("");
  const [deleteNode, setDeleteNode] = React.useState<NodeRecord | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showAdd, setShowAdd] = React.useState(false);
  const [addName, setAddName] = React.useState("");
  const [addHost, setAddHost] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const data = await api.get<{ nodes: NodeRecord[] }>("/api/nodes");
      setNodes(data.nodes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load nodes.");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Keep an open details dialog in sync with list refreshes.
  React.useEffect(() => {
    if (!detailsNode || !nodes) return;
    const fresh = nodes.find((n) => n.id === detailsNode.id);
    if (fresh && fresh.updated_at !== detailsNode.updated_at) setDetailsNode(fresh);
  }, [nodes, detailsNode]);

  const refreshNode = async (id: string): Promise<void> => {
    setCheckingId(id);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api.post<{ check: NodeCheck }>(`/api/nodes/${id}/check`);
      setNotice(res.check.ok ? "Health check completed: node is Online." : `Check completed: ${res.check.detail}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Health check failed.");
      await load();
    } finally {
      setCheckingId(null);
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (!editNode) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.patch(`/api/nodes/${editNode.id}`, { name: editName.trim() });
      setEditNode(null);
      setNotice("Node name updated.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Rename failed.");
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteNode) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.del(`/api/nodes/${deleteNode.id}`);
      setDeleteNode(null);
      setNotice("Node registration removed. Host containers were left untouched.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Remove failed.");
    } finally {
      setBusy(false);
    }
  };

  const addNode = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.post("/api/nodes", { name: addName.trim(), connection: "remote", host_address: addHost.trim() });
      setAddName("");
      setAddHost("");
      setShowAdd(false);
      setNotice("Node saved. Remote agents are not implemented, so it stays Unconfigured until verified.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not register node.");
    } finally {
      setBusy(false);
    }
  };

  const localExists = (nodes ?? []).some((n) => n.id === "local" || n.endpoint === "local");

  return (
    <div>
      <PageHeader
        title="Nodes"
        subtitle="Manage the hosts that run your LXC containers."
        actions={
          <Button type="button" variant="ghost" onClick={() => setShowAdd((v) => !v)} aria-expanded={showAdd}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add node
          </Button>
        }
      />
      <InlineAlert message={error} />
      {notice ? (
        <div role="status" className="mb-4 rounded-md border border-highlight bg-raised px-3 py-2 text-sm text-primary">
          {notice}
        </div>
      ) : null}

      {showAdd ? (
        <Card className="mb-5">
          <h2 className="mb-1 text-sm font-semibold text-primary">Register a node</h2>
          <p className="mb-4 text-sm text-muted">
            Only the local host integration is implemented. The Local Node registers itself automatically
            {localExists ? " (already present below)" : ""}; remote entries are stored as configuration only and cannot
            be operated until a secure remote agent exists.
          </p>
          <form onSubmit={addNode} className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="node-name">Node name</Label>
              <Input
                id="node-name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="office-hypervisor"
                required
                maxLength={120}
                disabled={busy}
              />
            </div>
            <div>
              <Label htmlFor="node-host">Host address</Label>
              <Input
                id="node-host"
                value={addHost}
                onChange={(e) => setAddHost(e.target.value)}
                placeholder="192.0.2.10 or hypervisor2"
                required
                maxLength={255}
                disabled={busy}
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save node configuration"}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {nodes === null && !error ? (
        <p className="text-sm text-muted" role="status">Loading nodes…</p>
      ) : nodes && nodes.length === 0 ? (
        <EmptyState
          title="No nodes registered"
          hint="The Local Node normally registers itself on startup. If it is missing, restart the backend to trigger initialization."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="kct-table kct-card w-full min-w-[880px] border-collapse overflow-hidden">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Identifier</th>
                <th scope="col">Type</th>
                <th scope="col">Host</th>
                <th scope="col">Status</th>
                <th scope="col">Containers</th>
                <th scope="col">Last check</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(nodes ?? []).map((n) => {
                const caps = parseCapabilities(n.capabilities);
                const detected =
                  caps?.containersTotal !== null && caps?.containersTotal !== undefined
                    ? `${caps.containersTotal} (${caps.containersRunning ?? 0} running)`
                    : "Unavailable";
                return (
                  <tr key={n.id}>
                    <td>
                      <span className="font-medium text-primary">{n.name}</span>
                      {n.is_protected ? (
                        <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">
                          Protected
                        </span>
                      ) : null}
                    </td>
                    <td className="font-mono text-xs text-muted">{n.id}</td>
                    <td className="text-muted">{n.node_type === "local" ? "Local" : "Remote"}</td>
                    <td className="font-mono text-xs text-muted">{n.endpoint === "local" ? "Local host" : n.endpoint}</td>
                    <td>
                      <StatusBadge status={n.status} />
                      {n.last_error ? (
                        <span className="block max-w-56 truncate text-xs text-muted" title={n.last_error}>
                          {n.last_error}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-muted">
                      {n.managed_containers} managed · {detected} detected
                    </td>
                    <td className="text-muted">
                      {fmtTime(n.last_check_at)}
                      {isStale(n.last_check_at) ? <span title="Older than 15 minutes"> · stale</span> : null}
                    </td>
                    <td>
                      <div className="flex gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          className="px-2.5 py-1.5 text-xs"
                          onClick={() => setDetailsNode(n)}
                        >
                          Details
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="px-2.5 py-1.5 text-xs"
                          disabled={checkingId !== null}
                          onClick={() => void refreshNode(n.id)}
                          aria-label={`Refresh health check for ${n.name}`}
                        >
                          <RefreshCw
                            className={cn("h-3.5 w-3.5", checkingId === n.id && "animate-spin")}
                            aria-hidden="true"
                          />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="px-2.5 py-1.5 text-xs"
                          onClick={() => {
                            setEditNode(n);
                            setEditName(n.name);
                          }}
                          aria-label={`Rename ${n.name}`}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        {n.is_protected ? null : (
                          <Button
                            type="button"
                            variant="ghost"
                            className="px-2.5 py-1.5 text-xs"
                            onClick={() => setDeleteNode(n)}
                            aria-label={`Remove ${n.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detailsNode ? (
        <Modal title={`Node · ${detailsNode.name}`} wide onClose={() => setDetailsNode(null)}>
          <NodeDetails node={detailsNode} onClose={() => setDetailsNode(null)} onChanged={() => void load()} />
        </Modal>
      ) : null}

      {editNode ? (
        <Modal title={`Rename · ${editNode.name}`} onClose={() => setEditNode(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
            className="grid gap-4"
          >
            <div>
              <Label htmlFor="rename">Display name</Label>
              <Input
                id="rename"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                maxLength={120}
                disabled={busy}
              />
              <p className="mt-1.5 text-xs text-muted">
                Only the display name can change. The identifier, connection type, and provider are immutable.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditNode(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {deleteNode ? (
        <Modal title={`Remove · ${deleteNode.name}`} onClose={() => setDeleteNode(null)}>
          <p className="text-sm text-muted">
            Remove the registration for <span className="text-primary">{deleteNode.name}</span>? The node
            {deleteNode.managed_containers > 0
              ? ` still has ${deleteNode.managed_containers} managed instance record(s) — removal is blocked until they are reassigned.`
              : " has no managed instances."}{" "}
            Host containers are never touched by this action.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDeleteNode(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" variant="danger" onClick={() => void confirmDelete()} disabled={busy}>
              {busy ? "Removing…" : "Remove registration"}
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
