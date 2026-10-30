import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { ApiError, api, type Instance } from "@/lib/api";
import { avatarDataUri } from "@/lib/avatar";
import {
  Button,
  Card,
  EmptyState,
  InlineAlert,
  Label,
  PageHeader,
  StatusBadge,
} from "@/components/ui/primitives";
import {
  ConsoleTab,
  NetworkTab,
  NotesTab,
  OverviewTab,
  ResourcesTab,
  SettingsTab,
  TABS,
  TabErrorBoundary,
  formatDateTime,
  type InstanceDetail,
  type LiveState,
  type TabId,
} from "@/pages/InstanceDetails";
import { FilesTab } from "@/pages/InstanceFiles";

interface AdminInstanceDetail {
  instance: Instance & { owner_id: string };
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

function TransferCard({
  instanceId,
  currentOwnerId,
  onTransferred,
}: {
  instanceId: string;
  currentOwnerId: string;
  onTransferred: () => void;
}): React.JSX.Element {
  const [users, setUsers] = React.useState<{ id: string; name: string; email: string; status: string }[]>([]);
  const [target, setTarget] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const [truncated, setTruncated] = React.useState(false);

  React.useEffect(() => {
    api
      .get<{ users: { id: string; name: string; email: string; status: string }[]; pagination: { total: number } }>(
        "/api/admin/users?page=1&page_size=100"
      )
      .then((d) => {
        setUsers(d.users);
        setTruncated(d.pagination.total > d.users.length);
      })
      .catch(() => undefined);
  }, []);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!target || busy) return;
    const chosen = users.find((u) => u.id === target);
    if (!chosen) return;
    if (
      !window.confirm(
        `Transfer this VPS to ${chosen.name} (${chosen.email})? The host container is untouched; only the owner record changes, and the move is audited.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.post(`/api/admin/instances/${instanceId}/transfer`, { target_user_id: target });
      setTarget("");
      onTransferred();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not transfer ownership.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-primary">Transfer ownership</h2>
      <p className="mb-3 text-xs text-muted">
        Moves this VPS to another active user without touching the host container. Disabled accounts cannot receive
        instances.
      </p>
      <InlineAlert message={error} />
      <form onSubmit={(e) => void submit(e)} className="flex max-w-md flex-col gap-3">
        <div>
          <Label htmlFor="transfer-target">Target user</Label>
          <select
            id="transfer-target"
            className="kct-input"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={busy}
          >
            <option value="">Select a user…</option>
            {users
              .filter((u) => u.id !== currentOwnerId && u.status === "active")
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
          </select>
          {truncated ? (
            <p className="mt-1 text-xs text-muted">Showing the first 100 users; find others on the Users page.</p>
          ) : null}
        </div>
        <div>
          <Button type="submit" disabled={busy || !target}>
            {busy ? "Transferring…" : "Transfer VPS"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function AdminInstanceDetailPage(): React.JSX.Element {
  const { id, tabId } = useParams<{ id: string; tabId?: string }>();
  const navigate = useNavigate();
  const normalizedTab = tabId === "network" ? "resources" : tabId;
  const tab: TabId = TABS.some((t) => t.id === normalizedTab) ? (normalizedTab as TabId) : "overview";

  const [data, setData] = React.useState<AdminInstanceDetail | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const d = await api.get<AdminInstanceDetail>(`/api/admin/instances/${id}`);
      setData(d);
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

  const refresh = React.useCallback(() => {
    void load();
  }, [load]);

  const selectTab = React.useCallback(
    (next: TabId) => {
      if (!id) return;
      navigate(`/admin/instances/${id}/${next}`);
    },
    [id, navigate]
  );

  const detail: InstanceDetail | null = data
    ? { instance: data.instance, live: data.live }
    : null;

  return (
    <div>
      <div className="mb-4">
        <Link to="/admin/instances" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-primary">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to instances
        </Link>
      </div>
      {loading && !data ? (
        <p className="text-sm text-muted" role="status">
          Loading instance…
        </p>
      ) : error && !data ? (
        <EmptyState title="Instance not available" hint={error} />
      ) : data && detail ? (
        <div>
          <PageHeader
            title={data.instance.name}
            subtitle={`Container ${data.instance.container_id} · ${data.node ? data.node.name : "no node"}`}
            actions={
              <div className="flex items-center gap-2">
                {data.live.exists === false ? (
                  <StatusBadge status="missing" />
                ) : data.live.exists === null ? (
                  <span title={data.live.error ?? "Host state could not be checked."}>
                    <StatusBadge status="unavailable" />
                  </span>
                ) : (
                  <StatusBadge status={data.live.status ?? data.instance.status} />
                )}
                <Button type="button" variant="ghost" onClick={refresh} aria-label="Refresh instance state">
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            }
          />
          <InlineAlert message={error} />
          {notice ? (
            <div role="status" className="mb-4 rounded-md border border-highlight bg-raised px-3 py-2 text-sm text-primary">
              {notice}
            </div>
          ) : null}

          <div className="mb-5 grid gap-4 md:grid-cols-2">
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-primary">Owner</h2>
              {data.owner ? (
                <Link to={`/admin/users/${data.owner.id}`} className="flex items-center gap-3 hover:underline">
                  <img
                    src={avatarDataUri(data.owner.avatar_seed || data.owner.email)}
                    alt=""
                    aria-hidden="true"
                    className="h-10 w-10 rounded-full"
                  />
                  <span>
                    <span className="block text-sm font-medium text-primary">{data.owner.name}</span>
                    <span className="block text-xs text-muted">{data.owner.email}</span>
                    <span className="mt-1 inline-block">
                      <StatusBadge status={data.owner.status} />
                    </span>
                  </span>
                </Link>
              ) : (
                <div>
                  <p className="text-sm font-medium text-primary">Unassigned</p>
                  <p className="mt-1 text-xs text-muted">
                    No user record matches owner <span className="font-mono">{data.instance.owner_id}</span>. The
                    relationship is inconsistent — transfer the VPS to a valid user to repair it.
                  </p>
                </div>
              )}
              <p className="mt-3 text-xs text-muted">Node: {data.node ? `${data.node.name} (${data.node.endpoint})` : "not attached"}</p>
            </Card>
            <TransferCard
              instanceId={data.instance.id}
              currentOwnerId={data.instance.owner_id}
              onTransferred={() => {
                setNotice("Ownership transferred and audited.");
                void load();
              }}
            />
          </div>

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
              {tab === "notes" && <NotesTab detail={detail} onRefresh={refresh} isAdmin />}
              {tab === "console" && (
                <ConsoleTab
                  instanceId={detail.instance.id}
                  instanceName={detail.instance.name}
                  running={detail.live.exists ? detail.live.status === "running" : false}
                  onRefreshInstance={refresh}
                />
              )}
              {tab === "resources" && <ResourcesTab detail={detail} onRefresh={refresh} isAdmin />}
              {tab === "files" && <FilesTab instanceId={detail.instance.id} />}
              {tab === "settings" && (
                <SettingsTab
                  detail={detail}
                  onRefresh={refresh}
                  isAdmin
                  onDeleted={() => navigate("/admin/instances")}
                />
              )}
            </TabErrorBoundary>
          </div>
          <p className="mt-4 text-xs text-muted">
            Created {formatDateTime(data.instance.created_at)} · updated {formatDateTime(data.instance.updated_at)} ·
            live state confirmed {formatDateTime(data.live.checkedAt)}.
          </p>
        </div>
      ) : null}
    </div>
  );
}
