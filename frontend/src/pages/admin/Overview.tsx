import * as React from "react";
import { ApiError, api } from "@/lib/api";
import { Card, EmptyState, InlineAlert, PageHeader, StatusBadge } from "@/components/ui/primitives";

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
  recent_events: { id: string; action: string; actor_id: string | null; target_type: string | null; created_at: string }[];
  migration_version: number;
  app_version: string;
}

export function AdminOverviewPage(): React.JSX.Element {
  const [data, setData] = React.useState<Overview | null>(null);
  const [error, setError] = React.useState<string | undefined>();

  React.useEffect(() => {
    api.get<{ [K in keyof Overview]: Overview[K] }>("/api/admin/overview")
      .then((d) => setData(d as unknown as Overview))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Unable to load overview."));
  }, []);

  if (error) return <div><PageHeader title="Overview" /><InlineAlert message={error} /></div>;
  if (!data) return <div><PageHeader title="Overview" /><p className="text-sm text-muted" role="status">Loading…</p></div>;

  const stats: [string, string][] = [
    ["Registered users", String(data.users_total)],
    ["Managed containers", String(data.containers_total)],
    ["Running", String(data.containers_running)],
    ["Stopped", String(data.containers_stopped)],
    ["Virtualization nodes", String(data.nodes_total)],
  ];

  return (
    <div>
      <PageHeader title="Overview" subtitle="Live panel and infrastructure status. Every figure comes from stored records or the host integration." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {stats.map(([label, value]) => (
          <Card key={label} className="p-4">
            <p className="text-2xl font-semibold tracking-tight text-primary">{value}</p>
            <p className="mt-1 text-xs text-muted">{label}</p>
          </Card>
        ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-primary">Infrastructure</h2>
          {!data.infra_configured ? (
            <EmptyState title="No virtualization node configured" hint="Register a node under Settings → Infrastructure, or via the Nodes API, before creating containers." />
          ) : data.utilization ? (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {Object.entries(data.utilization).map(([k, v]) => (
                <div key={k} className="rounded border border-border px-2.5 py-2">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="text-sm text-primary">{typeof v === "object" ? JSON.stringify(v) : String(v ?? "Unavailable")}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted">Integration status: {data.infra_status}. Live utilization is Unavailable.</p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            {data.nodes.map((n) => (
              <div key={n.id} className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm">
                <span className="text-primary">{n.name} <span className="ml-2 font-mono text-xs text-muted">{n.endpoint}</span></span>
                <StatusBadge status={n.status} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold text-primary">Recent events</h2>
          {data.recent_events.length === 0 ? (
            <EmptyState title="No events yet" hint="Administrative and infrastructure operations will appear here." />
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {data.recent_events.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
                  <span className="font-mono text-xs text-primary">{e.action}</span>
                  <span className="text-xs text-muted">{new Date(e.created_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">App version {data.app_version} · migration {data.migration_version}</p>
        </Card>
      </div>
    </div>
  );
}
