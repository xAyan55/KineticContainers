import * as React from "react";
import {
  Check,
  Copy,
  Key,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  Trash2,
  X,
  Server,
  Activity,
  Globe,
} from "lucide-react";
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
  tls_skip_verify?: boolean;
  cf_client_id?: string | null;
  agent_version?: string | null;
  enrolled_at?: string | null;
  has_auth_credential?: boolean;
  has_cf_access?: boolean;
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
  lxcfsActive: boolean;
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

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
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

function CredentialDisplayModal({
  title,
  credential,
  nodeName,
  endpoint,
  onClose,
}: {
  title: string;
  credential: string;
  nodeName: string;
  endpoint?: string;
  onClose: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const copyCredential = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(credential);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Best effort clipboard
    }
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-raised/50 p-4">
          <p className="text-xs font-semibold text-primary">Generated Node Authentication Credential</p>
          <p className="mt-1 text-xs text-muted">
            This token authenticates the controller with your remote node agent. It is stored securely encrypted at rest
            (AES-256-GCM) and will <strong className="text-primary font-medium">never be displayed again</strong>.
          </p>

          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={credential}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-primary focus:outline-none"
              aria-label="Node authentication credential"
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => void copyCredential()}
              className="shrink-0 px-3 py-2 text-xs"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 text-primary" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Copy
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-border p-4 text-xs space-y-3">
          <p className="font-semibold text-primary">Remote Node Agent Setup Instructions</p>
          <ol className="list-decimal list-inside space-y-2 text-muted leading-relaxed">
            <li>
              On your remote Linux server or NAT VPS, install the KineticCT Agent:
              <div className="mt-1 bg-surface p-2 rounded border border-border font-mono text-[11px] text-primary overflow-x-auto">
                curl -fsSL https://raw.githubusercontent.com/xAyan55/KineticContainers/main/agent/install-agent.sh | bash
              </div>
            </li>
            <li>
              Set the node credential in <span className="font-mono text-primary">/etc/kineticct-agent/agent.env</span>:
              <div className="mt-1 bg-surface p-2 rounded border border-border font-mono text-[11px] text-primary overflow-x-auto">
                KINETICCT_NODE_AUTH_CREDENTIAL="{credential}"
              </div>
            </li>
            <li>
              Configure Cloudflare Tunnel (<span className="font-mono text-primary">cloudflared</span>) to point your public hostname to the local agent HTTPS port:
              <div className="mt-1 bg-surface p-2 rounded border border-border font-mono text-[11px] text-primary overflow-x-auto">
                ingress:<br />
                &nbsp;&nbsp;- hostname: {endpoint ? new URL(endpoint.startsWith("http") ? endpoint : `https://${endpoint}`).hostname : "node.example.com"}<br />
                &nbsp;&nbsp;&nbsp;&nbsp;service: https://localhost:5433<br />
                &nbsp;&nbsp;&nbsp;&nbsp;originRequest:<br />
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;noTLSVerify: true<br />
                &nbsp;&nbsp;- service: http_status:404
              </div>
            </li>
            <li>
              Restart the agent service:
              <div className="mt-1 bg-surface p-2 rounded border border-border font-mono text-[11px] text-primary">
                systemctl restart kineticct-agent
              </div>
            </li>
          </ol>
        </div>

        <div className="flex justify-end pt-2">
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function NodeDetails({
  node,
  onClose,
  onChanged,
  onRotateCredential,
}: {
  node: NodeRecord;
  onClose: () => void;
  onChanged: () => void;
  onRotateCredential?: (node: NodeRecord) => void;
}): React.JSX.Element {
  const [check, setCheck] = React.useState<NodeCheck | null>(null);
  const [containers, setContainers] = React.useState<NodeContainer[] | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | undefined>();

  const runCheck = React.useCallback(async () => {
    setChecking(true);
    setError(undefined);
    setTestResult(null);
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
      onChanged();
    } finally {
      setChecking(false);
    }
  }, [node.id, onChanged]);

  const testConnectivity = async (): Promise<void> => {
    setTesting(true);
    setError(undefined);
    setTestResult(null);
    try {
      const res = await api.post<{ status: { status: string; agentVersion?: string } }>(`/api/nodes/${node.id}/test`);
      setTestResult(`Connectivity verified: agent is online (version ${res.status.agentVersion || "active"}).`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Connectivity test failed.");
      onChanged();
    } finally {
      setTesting(false);
    }
  };

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
        {node.node_type === "remote" ? (
          <Button type="button" variant="ghost" onClick={() => void testConnectivity()} disabled={testing || checking}>
            <Activity className={cn("h-4 w-4", testing && "animate-spin")} aria-hidden="true" />
            {testing ? "Testing…" : "Test connection"}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => void runCheck()} disabled={checking || testing}>
          <RefreshCw className={cn("h-4 w-4", checking && "animate-spin")} aria-hidden="true" />
          {checking ? "Checking…" : "Refresh"}
        </Button>
      </div>

      <InlineAlert message={error} />
      {testResult ? (
        <div role="status" className="rounded-md border border-border bg-raised/50 px-3 py-2 text-xs text-primary">
          {testResult}
        </div>
      ) : null}
      {check && !check.ok ? <InlineAlert message={check.detail} /> : null}

      {!node.is_protected ? null : (
        <p className="text-xs text-muted">
          This node represents the panel host itself. Its display name can be changed, but its identity and provider
          configuration are fixed and it cannot be removed.
        </p>
      )}

      <section aria-label="General information">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-primary">General</h3>
          {node.node_type === "remote" && onRotateCredential ? (
            <Button
              type="button"
              variant="ghost"
              className="px-2.5 py-1 text-xs"
              onClick={() => onRotateCredential(node)}
            >
              <Key className="h-3.5 w-3.5" aria-hidden="true" />
              Rotate credential
            </Button>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Stat label="Node name" value={node.name} />
          <Stat label="Identifier" value={node.id} />
          <Stat label="Type" value={node.node_type === "local" ? "Local Node" : "Remote Node (Agent)"} />
          <Stat label="Provider" value={node.provider} />
          <Stat label="Endpoint" value={node.endpoint === "local" ? "Local Host" : node.endpoint} />
          <Stat
            label="Agent version"
            value={unavailable(node.agent_version || (check?.host ? "Connected" : null))}
          />
          {node.node_type === "remote" ? (
            <>
              <Stat
                label="TLS certificate verification"
                value={node.tls_skip_verify ? "Disabled (Skip Verify)" : "Enabled (Strict)"}
              />
              <Stat
                label="Cloudflare Access"
                value={node.cf_client_id || node.has_cf_access ? "Configured (Service Token)" : "None"}
              />
              <Stat label="Enrolled at" value={fmtTime(node.enrolled_at)} />
              <Stat
                label="Authentication"
                value={node.has_auth_credential ? "Credential configured" : "Pending enrollment"}
              />
            </>
          ) : null}
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
              <Stat
                label="LXCFS views"
                value={ready.lxcfsActive ? "Serving" : "Not serving"}
              />
            </div>
          );
        })()}
      </section>

      <section aria-label="Container inventory">
        <h3 className="mb-2 text-sm font-semibold text-primary">Containers on this node</h3>
        {containers === null ? (
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
                        <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">
                          Unmanaged
                        </span>
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
  const [editTlsSkip, setEditTlsSkip] = React.useState(false);
  const [editCfClientId, setEditCfClientId] = React.useState("");
  const [editCfClientSecret, setEditCfClientSecret] = React.useState("");
  const [deleteNode, setDeleteNode] = React.useState<NodeRecord | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Add node form state
  const [showAdd, setShowAdd] = React.useState(false);
  const [addName, setAddName] = React.useState("");
  const [addConnection, setAddConnection] = React.useState<"local" | "remote">("remote");
  const [addEndpoint, setAddEndpoint] = React.useState("");
  const [addTlsSkip, setAddTlsSkip] = React.useState(false);
  const [addCfAccess, setAddCfAccess] = React.useState(false);
  const [addCfClientId, setAddCfClientId] = React.useState("");
  const [addCfClientSecret, setAddCfClientSecret] = React.useState("");

  // Post-enrollment credential modal
  const [enrolledCredential, setEnrolledCredential] = React.useState<{
    credential: string;
    nodeName: string;
    endpoint: string;
  } | null>(null);

  // Rotate credential modal
  const [rotateNode, setRotateNode] = React.useState<NodeRecord | null>(null);
  const [rotatedCredential, setRotatedCredential] = React.useState<{
    credential: string;
    nodeName: string;
  } | null>(null);

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

  const openEdit = (n: NodeRecord): void => {
    setEditNode(n);
    setEditName(n.name);
    setEditTlsSkip(Boolean(n.tls_skip_verify));
    setEditCfClientId(n.cf_client_id ?? "");
    setEditCfClientSecret("");
  };

  const saveEdit = async (): Promise<void> => {
    if (!editNode) return;
    setBusy(true);
    setError(undefined);
    try {
      const payload: Record<string, unknown> = { name: editName.trim() };
      if (editNode.node_type === "remote") {
        payload.tls_skip_verify = editTlsSkip;
        payload.cf_client_id = editCfClientId.trim() || null;
        if (editCfClientSecret.trim()) {
          payload.cf_client_secret = editCfClientSecret.trim();
        }
      }
      await api.patch(`/api/nodes/${editNode.id}`, payload);
      setEditNode(null);
      setNotice("Node configuration updated.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed.");
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
      const payload: Record<string, unknown> = {
        name: addName.trim(),
        connection: addConnection,
      };

      if (addConnection === "remote") {
        payload.endpoint = addEndpoint.trim();
        payload.tls_skip_verify = addTlsSkip;
        if (addCfAccess) {
          if (addCfClientId.trim()) payload.cf_client_id = addCfClientId.trim();
          if (addCfClientSecret.trim()) payload.cf_client_secret = addCfClientSecret.trim();
        }
      }

      const res = await api.post<{
        node: NodeRecord;
        credential?: string;
        enrollment_token?: string;
      }>("/api/nodes", payload);

      setAddName("");
      setAddEndpoint("");
      setAddTlsSkip(false);
      setAddCfAccess(false);
      setAddCfClientId("");
      setAddCfClientSecret("");
      setShowAdd(false);

      if (res.credential) {
        setEnrolledCredential({
          credential: res.credential,
          nodeName: res.node.name,
          endpoint: res.node.endpoint,
        });
      } else {
        setNotice("Node saved successfully.");
      }

      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not register node.");
    } finally {
      setBusy(false);
    }
  };

  const executeRotateCredential = async (node: NodeRecord): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.post<{ node: NodeRecord; credential: string }>(
        `/api/nodes/${node.id}/rotate-credential`
      );
      setRotateNode(null);
      setRotatedCredential({
        credential: res.credential,
        nodeName: node.name,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Credential rotation failed.");
    } finally {
      setBusy(false);
    }
  };

  const localExists = (nodes ?? []).some((n) => n.id === "local" || n.endpoint === "local");

  return (
    <div>
      <PageHeader
        title="Nodes"
        subtitle="Manage the hypervisor hosts that run your LXC containers."
        actions={
          <Button type="button" variant="ghost" onClick={() => setShowAdd((v) => !v)} aria-expanded={showAdd}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add node
          </Button>
        }
      />

      <InlineAlert message={error} />
      {notice ? (
        <div role="status" className="mb-4 rounded-md border border-border bg-raised px-3 py-2 text-sm text-primary">
          {notice}
        </div>
      ) : null}

      {showAdd ? (
        <Card className="mb-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-primary">Register a Node</h2>
            <p className="mt-1 text-xs text-muted">
              Connect a separate Linux VPS or server running LXC via an outbound Cloudflare Tunnel, or register the local host.
            </p>
          </div>

          <form onSubmit={addNode} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="node-name">Node display name</Label>
                <Input
                  id="node-name"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="e.g. us-east-nat-vps"
                  required
                  maxLength={120}
                  disabled={busy}
                />
              </div>

              <div>
                <Label htmlFor="node-connection">Connection type</Label>
                <select
                  id="node-connection"
                  value={addConnection}
                  onChange={(e) => setAddConnection(e.target.value as "local" | "remote")}
                  disabled={busy}
                  className="kct-input w-full"
                >
                  <option value="remote">Remote Node (Outbound Cloudflare Tunnel / HTTPS)</option>
                  <option value="local" disabled={localExists}>
                    Local Host Node {localExists ? "(Already registered)" : ""}
                  </option>
                </select>
              </div>
            </div>

            {addConnection === "remote" ? (
              <div className="space-y-4 rounded-md border border-border p-4 bg-surface">
                <div>
                  <Label htmlFor="node-endpoint">Remote Agent Public HTTPS URL</Label>
                  <Input
                    id="node-endpoint"
                    value={addEndpoint}
                    onChange={(e) => setAddEndpoint(e.target.value)}
                    placeholder="https://node.example.com"
                    required
                    maxLength={1024}
                    disabled={busy}
                  />
                  <p className="mt-1 text-xs text-muted">
                    Enter the public HTTPS Cloudflare Tunnel hostname reaching port 5433 on your remote VPS. Loopback addresses (<span className="font-mono">localhost</span> / <span className="font-mono">127.0.0.1</span>) are rejected because the controller cannot reach remote VPS hosts over localhost.
                  </p>
                </div>

                <div className="pt-2 border-t border-border">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addTlsSkip}
                      onChange={(e) => setAddTlsSkip(e.target.checked)}
                      disabled={busy}
                      className="mt-1 rounded border-border"
                    />
                    <div>
                      <span className="text-xs font-medium text-primary">
                        Skip TLS Certificate Verification
                      </span>
                      <p className="text-[11px] text-muted">
                        Only enable this if connecting directly to a self-signed origin certificate in an isolated test environment without Cloudflare.
                      </p>
                    </div>
                  </label>

                  {addTlsSkip ? (
                    <div className="mt-2.5 flex items-start gap-2 rounded-md border border-border bg-raised/70 p-2.5 text-xs text-primary">
                      <ShieldAlert className="h-4 w-4 shrink-0 text-muted mt-0.5" aria-hidden="true" />
                      <span>
                        <strong className="font-medium">Security Warning:</strong> Skipping TLS certificate verification exposes this connection to man-in-the-middle attacks. It is strictly scoped to this node.
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="pt-2 border-t border-border">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addCfAccess}
                      onChange={(e) => setAddCfAccess(e.target.checked)}
                      disabled={busy}
                      className="mt-1 rounded border-border"
                    />
                    <div>
                      <span className="text-xs font-medium text-primary">
                        Cloudflare Access Service Token (Optional)
                      </span>
                      <p className="text-[11px] text-muted">
                        Enable if this tunnel route is protected by a Cloudflare Access policy requiring Service Authentication tokens.
                      </p>
                    </div>
                  </label>

                  {addCfAccess ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="cf-client-id" className="text-xs">
                          CF-Access-Client-Id
                        </Label>
                        <Input
                          id="cf-client-id"
                          value={addCfClientId}
                          onChange={(e) => setAddCfClientId(e.target.value)}
                          placeholder="e.g. 1a2b3c4d5e6f.access"
                          disabled={busy}
                          className="text-xs"
                        />
                      </div>
                      <div>
                        <Label htmlFor="cf-client-secret" className="text-xs">
                          CF-Access-Client-Secret
                        </Label>
                        <Input
                          id="cf-client-secret"
                          type="password"
                          value={addCfClientSecret}
                          onChange={(e) => setAddCfClientSecret(e.target.value)}
                          placeholder="Enter service secret"
                          disabled={busy}
                          className="text-xs"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setShowAdd(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Registering…" : "Enroll and register node"}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {nodes === null && !error ? (
        <p className="text-sm text-muted" role="status">
          Loading nodes…
        </p>
      ) : nodes && nodes.length === 0 ? (
        <EmptyState
          title="No nodes registered"
          hint="The Local Node normally registers itself on startup. Click 'Add node' to register a remote VPS node."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="kct-table kct-card w-full min-w-[880px] border-collapse overflow-hidden">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Identifier</th>
                <th scope="col">Type</th>
                <th scope="col">Host / Endpoint</th>
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
                    <td className="text-muted">
                      {n.node_type === "local" ? "Local" : "Remote (Agent)"}
                    </td>
                    <td className="font-mono text-xs text-muted">
                      {n.endpoint === "local" ? "Local host" : n.endpoint}
                    </td>
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
                      <div className="flex items-center gap-1.5">
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
                        {n.node_type === "remote" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            className="px-2.5 py-1.5 text-xs"
                            onClick={() => setRotateNode(n)}
                            aria-label={`Rotate credential for ${n.name}`}
                          >
                            <Key className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          className="px-2.5 py-1.5 text-xs"
                          onClick={() => openEdit(n)}
                          aria-label={`Edit ${n.name}`}
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

      {/* Details Dialog */}
      {detailsNode ? (
        <Modal title={`Node · ${detailsNode.name}`} wide onClose={() => setDetailsNode(null)}>
          <NodeDetails
            node={detailsNode}
            onClose={() => setDetailsNode(null)}
            onChanged={() => void load()}
            onRotateCredential={(n) => {
              setDetailsNode(null);
              setRotateNode(n);
            }}
          />
        </Modal>
      ) : null}

      {/* Enrollment Credential Modal */}
      {enrolledCredential ? (
        <CredentialDisplayModal
          title={`Node Enrolled · ${enrolledCredential.nodeName}`}
          credential={enrolledCredential.credential}
          nodeName={enrolledCredential.nodeName}
          endpoint={enrolledCredential.endpoint}
          onClose={() => setEnrolledCredential(null)}
        />
      ) : null}

      {/* Rotated Credential Modal */}
      {rotatedCredential ? (
        <CredentialDisplayModal
          title={`Credential Rotated · ${rotatedCredential.nodeName}`}
          credential={rotatedCredential.credential}
          nodeName={rotatedCredential.nodeName}
          onClose={() => setRotatedCredential(null)}
        />
      ) : null}

      {/* Confirm Rotate Credential Dialog */}
      {rotateNode ? (
        <Modal title={`Rotate Credential · ${rotateNode.name}`} onClose={() => setRotateNode(null)}>
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Rotating the credential will invalidate the previous key. You will need to update the configuration file on
              the remote node host (<span className="font-mono text-primary">/etc/kineticct-agent/agent.env</span>) with the new credential, or the controller will lose connectivity.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRotateNode(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void executeRotateCredential(rotateNode)} disabled={busy}>
                {busy ? "Generating…" : "Generate new credential"}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* Edit Node Dialog */}
      {editNode ? (
        <Modal title={`Edit · ${editNode.name}`} onClose={() => setEditNode(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
            className="space-y-4"
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
            </div>

            {editNode.node_type === "remote" ? (
              <div className="space-y-3 pt-3 border-t border-border">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editTlsSkip}
                    onChange={(e) => setEditTlsSkip(e.target.checked)}
                    disabled={busy}
                    className="mt-1 rounded border-border"
                  />
                  <div>
                    <span className="text-xs font-medium text-primary">
                      Skip TLS Certificate Verification
                    </span>
                    <p className="text-[11px] text-muted">
                      Disable verification for self-signed certificates. Applied strictly to requests for this node.
                    </p>
                  </div>
                </label>

                <div>
                  <Label htmlFor="edit-cf-client-id" className="text-xs">
                    Cloudflare Access Client ID (Optional)
                  </Label>
                  <Input
                    id="edit-cf-client-id"
                    value={editCfClientId}
                    onChange={(e) => setEditCfClientId(e.target.value)}
                    placeholder="Leave blank if not using Cloudflare Access"
                    disabled={busy}
                    className="text-xs"
                  />
                </div>

                <div>
                  <Label htmlFor="edit-cf-client-secret" className="text-xs">
                    Cloudflare Access Client Secret (Optional)
                  </Label>
                  <Input
                    id="edit-cf-client-secret"
                    type="password"
                    value={editCfClientSecret}
                    onChange={(e) => setEditCfClientSecret(e.target.value)}
                    placeholder="Leave blank to keep existing secret"
                    disabled={busy}
                    className="text-xs"
                  />
                </div>
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setEditNode(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* Delete Node Dialog */}
      {deleteNode ? (
        <Modal title={`Remove · ${deleteNode.name}`} onClose={() => setDeleteNode(null)}>
          <p className="text-sm text-muted">
            Remove the registration for <span className="text-primary font-medium">{deleteNode.name}</span>? The node
            {deleteNode.managed_containers > 0
              ? ` still has ${deleteNode.managed_containers} managed instance record(s) — removal is blocked until they are removed.`
              : " has no managed instances."}{" "}
            Host containers on the machine are never touched by this action.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDeleteNode(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => void confirmDelete()}
              disabled={busy || deleteNode.managed_containers > 0}
            >
              {busy ? "Removing…" : "Remove registration"}
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
