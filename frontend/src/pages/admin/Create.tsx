import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button, Card, InlineAlert, Input, Label, PageHeader } from "@/components/ui/primitives";

export function AdminCreatePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [nodes, setNodes] = React.useState<{ id: string; name: string }[]>([]);
  const [owners, setOwners] = React.useState<{ id: string; email: string; name: string }[]>([]);
  const [templates, setTemplates] = React.useState<string[]>([]);
  const [form, setForm] = React.useState({ name: "", node_id: "", owner_id: "", template: "", cpu: 2, memory_mb: 2048, storage_gb: 20, container_id: "" });
  const [error, setError] = React.useState<string | undefined>();
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api.get<{ nodes: { id: string; name: string }[] }>("/api/nodes").then((d) => {
      setNodes(d.nodes);
      setForm((f) => ({ ...f, node_id: f.node_id || d.nodes[0]?.id || "" }));
    }).catch(() => undefined);
    api.get<{ users: { id: string; email: string; name: string }[] }>("/api/admin/users?page=1&page_size=100").then((d) => {
      setOwners(d.users);
    }).catch(() => undefined);
    api.get<{ templates: string[] }>("/api/templates").then((d) => {
      setTemplates(d.templates);
      setForm((f) => ({ ...f, template: f.template || d.templates[0] || "" }));
    }).catch(() => undefined);
  }, []);

  const set = (k: keyof typeof form, v: string | number): void => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const payload = {
        ...form,
        container_id: form.container_id.trim() || undefined,
      };
      const data = await api.post<{ instance: { id: string } }>("/api/admin/instances", payload);
      navigate("/", { replace: false });
      void data;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Creation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Create" subtitle="Provision a real LXC container through the host integration." />
      {nodes.length === 0 ? (
        <Card><p className="text-sm text-muted">No virtualization node is configured, so creation is unavailable. Register a node first, then return here.</p></Card>
      ) : (
        <Card>
          <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
            <div><Label htmlFor="c-name">Instance name / hostname</Label><Input id="c-name" value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} maxLength={63} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" disabled={busy} /></div>
            <div><Label htmlFor="c-cid">Container id (optional, defaults to name)</Label><Input id="c-cid" value={form.container_id} onChange={(e) => set("container_id", e.target.value)} maxLength={63} disabled={busy} /></div>
            <div>
              <Label htmlFor="c-node">Target node</Label>
              <select id="c-node" className="kct-input" value={form.node_id} onChange={(e) => set("node_id", e.target.value)} required disabled={busy}>
                {nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="c-owner">Owner</Label>
              <select id="c-owner" className="kct-input" value={form.owner_id} onChange={(e) => set("owner_id", e.target.value)} required disabled={busy}>
                <option value="">Select a user…</option>
                {owners.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="c-tpl">Template</Label>
              <select id="c-tpl" className="kct-input" value={form.template} onChange={(e) => set("template", e.target.value)} required disabled={busy}>
                {templates.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label htmlFor="c-cpu">CPU</Label><Input id="c-cpu" type="number" min={1} max={32} value={form.cpu} onChange={(e) => set("cpu", Number(e.target.value))} required disabled={busy} /></div>
              <div><Label htmlFor="c-mem">RAM (MB)</Label><Input id="c-mem" type="number" min={128} max={131072} step={128} value={form.memory_mb} onChange={(e) => set("memory_mb", Number(e.target.value))} required disabled={busy} /></div>
              <div><Label htmlFor="c-disk">Disk (GB)</Label><Input id="c-disk" type="number" min={1} max={2000} value={form.storage_gb} onChange={(e) => set("storage_gb", Number(e.target.value))} required disabled={busy} /></div>
            </div>
            <div className="md:col-span-2">
              <InlineAlert message={error} />
              <div className="mt-3"><Button type="submit" disabled={busy}>{busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : "Create container"}</Button></div>
              <p className="mt-2 text-xs text-muted">The backend validates identifiers, templates, resources, and node reachability, then creates the container via the privileged host agent. Failures are reported honestly; partial states are marked “Failed”.</p>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
