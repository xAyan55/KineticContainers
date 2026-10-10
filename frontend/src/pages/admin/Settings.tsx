import * as React from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { refreshBranding } from "@/lib/branding";
import { Button, Card, InlineAlert, Input, Label, PageHeader, StatusBadge } from "@/components/ui/primitives";

type SettingsMap = Record<string, string>;

const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const FAVICON_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,.ico,image/x-icon";
const LOGO_MAX_BYTES = 1024 * 1024;
const FAVICON_MAX_BYTES = 256 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function BrandImageUploader({
  kind,
  label,
  hint,
  currentUrl,
  onChanged,
  onError,
}: {
  kind: "logo" | "favicon";
  label: string;
  hint: string;
  currentUrl: string;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}): React.JSX.Element {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<string | null>(null);
  const maxBytes = kind === "logo" ? LOGO_MAX_BYTES : FAVICON_MAX_BYTES;

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (file.size > maxBytes) {
      onError(`${label} is too large (${Math.round(file.size / 1024)} KB, max ${Math.round(maxBytes / 1024)} KB).`);
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      setPreview(dataUrl);
      await api.post<{ logo_url: string; favicon_url: string }>("/api/settings/branding", {
        [kind]: dataUrl,
      });
      if (inputRef.current) inputRef.current.value = "";
      setPreview(null);
      refreshBranding();
      onChanged(`${label} updated.`);
    } catch (err) {
      setPreview(null);
      onError(err instanceof ApiError ? err.message : `${label} upload failed.`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post("/api/settings/branding", { [kind]: null });
      refreshBranding();
      onChanged(`${label} removed.`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : `Could not remove ${label.toLowerCase()}.`);
    } finally {
      setBusy(false);
    }
  };

  const shown = preview ?? (currentUrl || null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-raised" aria-hidden="true">
          {shown ? (
            <img src={shown} alt="" className="max-h-14 max-w-14 object-contain" draggable={false} />
          ) : (
            <ImagePlus className="h-5 w-5 text-muted" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm font-medium text-primary">{label}</p>
          <p className="text-xs text-muted">{hint}</p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={kind === "logo" ? LOGO_ACCEPT : FAVICON_ACCEPT}
        className="sr-only"
        aria-label={`Choose a ${label.toLowerCase()} file`}
        disabled={busy}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Upload {label.toLowerCase()}…
        </Button>
        {currentUrl ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void remove()}>
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function AdminSettingsPage(): React.JSX.Element {
  const [settings, setSettings] = React.useState<SettingsMap | null>(null);
  const [meta, setMeta] = React.useState<{ migration_version: number; app_version: string; node_version: string } | null>(null);
  const [nodes, setNodes] = React.useState<{ id: string; name: string; endpoint: string; status: string }[]>([]);
  const [nodeName, setNodeName] = React.useState("");
  const [nodeEndpoint, setNodeEndpoint] = React.useState("local");
  const [error, setError] = React.useState<string | undefined>();
  const [msg, setMsg] = React.useState<string | undefined>();
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const d = await api.get<{ settings: SettingsMap; meta: { migration_version: number; app_version: string; node_version: string } }>("/api/settings");
      setSettings(d.settings);
      setMeta(d.meta);
      const n = await api.get<{ nodes: { id: string; name: string; endpoint: string; status: string }[] }>("/api/nodes");
      setNodes(n.nodes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load settings.");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const set = (k: string, v: string): void => setSettings((s) => (s ? { ...s, [k]: v } : s));

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError(undefined);
    setMsg(undefined);
    try {
      const d = await api.patch<{ settings: SettingsMap }>("/api/settings", {
        app_name: settings.app_name,
        app_description: settings.app_description,
        page_title: settings.page_title,
        registration_enabled: settings.registration_enabled === "true",
        session_ttl_hours: Number(settings.session_ttl_hours),
        password_min_length: Number(settings.password_min_length),
        timezone: settings.timezone,
      });
      setSettings(d.settings);
      setMsg("Settings saved successfully.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const addNode = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.post("/api/nodes", { name: nodeName, endpoint: nodeEndpoint });
      setNodeName("");
      await load();
      setMsg("Node registered. Use “Test” to verify the host integration.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not register node.");
    }
  };

  const testNode = async (id: string): Promise<void> => {
    setError(undefined);
    try {
      await api.post(`/api/nodes/${id}/test`);
      await load();
      setMsg("Connection test completed. See node status above.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Connection test failed.");
      await load();
    }
  };

  if (!settings) return <div><PageHeader title="Settings" /><p className="text-sm text-muted" role="status">Loading…</p><InlineAlert message={error} /></div>;
  return (
    <div>
      <PageHeader title="Settings" subtitle="Persisted to the database and applied immediately." />
      <form onSubmit={save} className="grid gap-5">
        <Card>
          <h2 className="mb-4 text-sm font-semibold text-primary">General</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div><Label htmlFor="s-app">Application name</Label><Input id="s-app" value={settings.app_name ?? ""} onChange={(e) => set("app_name", e.target.value)} maxLength={80} /></div>
            <div><Label htmlFor="s-title">Browser page title</Label><Input id="s-title" value={settings.page_title ?? ""} onChange={(e) => set("page_title", e.target.value)} maxLength={80} /></div>
            <div className="md:col-span-2"><Label htmlFor="s-desc">Description</Label><Input id="s-desc" value={settings.app_description ?? ""} onChange={(e) => set("app_description", e.target.value)} maxLength={500} /></div>
            <div><Label htmlFor="s-tz">Timezone / date display</Label><Input id="s-tz" value={settings.timezone ?? ""} onChange={(e) => set("timezone", e.target.value)} maxLength={80} /></div>
          </div>
        </Card>

        <Card>
          <h2 className="mb-4 text-sm font-semibold text-primary">Registration</h2>
          <div className="flex items-center gap-3">
            <input id="s-reg" type="checkbox" checked={settings.registration_enabled === "true"} onChange={(e) => set("registration_enabled", e.target.checked ? "true" : "false")} className="h-4 w-4 accent-white" />
            <Label htmlFor="s-reg" className="mb-0">Enable public registration (default: disabled)</Label>
          </div>
          <p className="mt-2 text-xs text-muted">Toggling affects both the frontend and the registration API immediately.</p>
        </Card>

        <Card>
          <h2 className="mb-4 text-sm font-semibold text-primary">Security</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div><Label htmlFor="s-ttl">Session lifetime (hours, 1–720)</Label><Input id="s-ttl" type="number" min={1} max={720} value={settings.session_ttl_hours ?? ""} onChange={(e) => set("session_ttl_hours", e.target.value)} /></div>
            <div><Label htmlFor="s-pw">Minimum password length (8–64)</Label><Input id="s-pw" type="number" min={8} max={64} value={settings.password_min_length ?? ""} onChange={(e) => set("password_min_length", e.target.value)} /></div>
          </div>
        </Card>

        <div>
          <Button type="submit" disabled={saving}>{saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : "Save settings"}</Button>
        </div>
      </form>

      <Card className="mt-5">
        <h2 className="mb-1 text-sm font-semibold text-primary">Branding</h2>
        <p className="mb-5 text-xs text-muted">Logo appears in the sidebar, header, and login page; the favicon appears in the browser tab. Raster images only (PNG, JPEG, WebP, GIF — plus ICO for favicons); SVG is rejected.</p>
        <div className="grid gap-6 md:grid-cols-2">
          <BrandImageUploader
            kind="logo"
            label="Logo"
            hint="PNG, JPEG, WebP, or GIF up to 1 MB. Shown at small sizes; simple marks work best."
            currentUrl={settings.logo_url ?? ""}
            onChanged={(m) => { setMsg(m); void load(); }}
            onError={(m) => setError(m)}
          />
          <BrandImageUploader
            kind="favicon"
            label="Favicon"
            hint="PNG, JPEG, WebP, GIF, or ICO up to 256 KB. Square images render best."
            currentUrl={settings.favicon_url ?? ""}
            onChanged={(m) => { setMsg(m); void load(); }}
            onError={(m) => setError(m)}
          />
        </div>
      </Card>

      <Card className="mt-5">
        <h2 className="mb-3 text-sm font-semibold text-primary">Infrastructure</h2>
        {nodes.length === 0 ? (
          <p className="text-sm text-muted">No virtualization nodes configured. The panel remains usable; creation reports “unavailable” honestly.</p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2">
            {nodes.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm">
                <span className="text-primary">{n.name} <span className="ml-1 font-mono text-xs text-muted">{n.endpoint}</span></span>
                <span className="flex items-center gap-2"><StatusBadge status={n.status} />
                  <button type="button" onClick={() => void testNode(n.id)} className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-primary">Test</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addNode} className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <div><Label htmlFor="n-name">Node name</Label><Input id="n-name" value={nodeName} onChange={(e) => setNodeName(e.target.value)} placeholder="lxc-host-01" required /></div>
          <div><Label htmlFor="n-ep">Endpoint (“local” for host agent)</Label><Input id="n-ep" value={nodeEndpoint} onChange={(e) => setNodeEndpoint(e.target.value)} required /></div>
          <div><Button type="submit" variant="ghost">Register node</Button></div>
        </form>
        <p className="mt-2 text-xs text-muted">Secrets are stored server-side and never returned by the API.</p>
      </Card>

      <Card className="mt-5">
        <h2 className="mb-2 text-sm font-semibold text-primary">Maintenance</h2>
        <p className="text-sm text-muted">App version: {meta?.app_version ?? "—"} · Migration: {meta?.migration_version ?? "—"} · Runtime: {meta?.node_version ?? "—"}</p>
      </Card>

      {msg ? <div role="status" className="mt-4 rounded-md border border-highlight bg-raised px-3 py-2 text-sm text-primary">{msg}</div> : null}
      <div className="mt-4"><InlineAlert message={error} /></div>
    </div>
  );
}
