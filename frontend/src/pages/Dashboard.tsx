import * as React from "react";
import { Link } from "react-router-dom";
import { Cpu, HardDrive, MemoryStick, Power } from "lucide-react";
import { useAuth } from "@/features/auth/AuthContext";
import { ApiError, api, type Instance } from "@/lib/api";
import { EmptyState, InlineAlert, PageHeader, StatusBadge } from "@/components/ui/primitives";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export function DashboardPage(): React.JSX.Element {
  const { user } = useAuth();
  const [instances, setInstances] = React.useState<Instance[] | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [acting, setActing] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const data = await api.get<{ instances: Instance[] }>("/api/instances");
      setInstances(data.instances);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load instances.");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: "start" | "stop" | "restart"): Promise<void> => {
    setActing(`${id}:${action}`);
    setError(undefined);
    try {
      await api.post(`/api/instances/${id}/actions`, { action });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Operation failed.");
    } finally {
      setActing(null);
    }
  };

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={user ? `Welcome, ${user.name}. Your assigned virtual servers are listed below.` : undefined} />
      <InlineAlert message={error} />
      {instances === null && !error ? (
        <p className="mt-4 text-sm text-muted" role="status">Loading instances…</p>
      ) : instances && instances.length === 0 ? (
        <div className="mt-4"><EmptyState title="No instances assigned" hint="No virtual servers are currently assigned to your account. Contact your administrator if you expected to see servers here." /></div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="kct-table kct-card w-full min-w-[760px] border-collapse overflow-hidden">
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Container</th><th scope="col">Status</th><th scope="col">Node</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Storage</th><th scope="col">Template</th><th scope="col">Created</th><th scope="col">Actions</th></tr>
            </thead>
            <tbody>
              {(instances ?? []).map((i) => (
                <tr key={i.id}>
                  <td className="font-medium text-primary">{i.name}</td>
                  <td className="font-mono text-xs text-muted">{i.container_id}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td className="text-muted">{i.node_name ?? "—"}</td>
                  <td><span className="inline-flex items-center gap-1 text-muted"><Cpu className="h-3.5 w-3.5" aria-hidden="true" />{i.cpu}</span></td>
                  <td><span className="inline-flex items-center gap-1 text-muted"><MemoryStick className="h-3.5 w-3.5" aria-hidden="true" />{i.memory_mb} MB</span></td>
                  <td><span className="inline-flex items-center gap-1 text-muted"><HardDrive className="h-3.5 w-3.5" aria-hidden="true" />{i.storage_gb} GB</span></td>
                  <td className="text-muted">{i.template ?? "—"}</td>
                  <td className="text-muted">{formatDate(i.created_at)}</td>
                  <td>
                    <div className="flex gap-1.5">
                      <button type="button" disabled={acting !== null} onClick={() => void act(i.id, "start")} aria-label={`Start ${i.name}`} title="Start" className="rounded border border-border p-1.5 text-muted hover:text-primary disabled:opacity-50">
                        <Power className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button type="button" disabled={acting !== null} onClick={() => void act(i.id, "stop")} aria-label={`Stop ${i.name}`} title="Stop" className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-primary disabled:opacity-50">
                        Stop
                      </button>
                      <button type="button" disabled={acting !== null} onClick={() => void act(i.id, "restart")} aria-label={`Restart ${i.name}`} title="Restart" className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-primary disabled:opacity-50">
                        Restart
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted">
            Power actions run against the real host integration. <Link to="/profile" className="underline">Manage your profile</Link> for account changes.
          </p>
        </div>
      )}
    </div>
  );
}
