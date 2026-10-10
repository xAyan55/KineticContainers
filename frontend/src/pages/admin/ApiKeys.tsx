import * as React from "react";
import { Check, Copy, KeyRound, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
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

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_by: string | null;
  created_by_name: string | null;
  created_by_key: string | null;
  scopes: string[];
  full_access: boolean;
  ip_allowlist: string[];
  expires_at: string | null;
  last_used_at: string | null;
  last_used_endpoint: string | null;
  use_count: number;
  rotated_from: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  status: "active" | "expired" | "revoked";
}

interface ScopeDefinition {
  id: string;
  label: string;
  group: string;
  description: string;
  sensitive?: boolean;
}

interface ScopeCatalogue {
  scopes: ScopeDefinition[];
  groups: { group: string; scopes: string[] }[];
  full_access: string;
}

interface Pagination {
  page: number;
  page_size: number;
  total: number;
  pages: number;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseAllowlist(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
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
        className={cn("kct-card relative max-h-[85vh] w-full overflow-y-auto p-5 outline-none", wide ? "max-w-2xl" : "max-w-lg")}
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

function SecretPanel({ secret, onDismiss }: { secret: string; onDismiss: () => void }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mb-5 rounded-md border border-highlight bg-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-primary">Copy this key now</p>
          <p className="mt-1 text-sm text-muted">
            This is the only time the secret is shown. KineticCT stores only a hash and cannot display it again.
          </p>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="rounded-md p-1.5 text-muted hover:bg-surface hover:text-primary">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded border border-border bg-surface px-3 py-2 text-xs text-primary">
          {secret}
        </code>
        <Button type="button" variant="ghost" onClick={() => void copy()}>
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Send it to the client over a secure channel. Never paste it into frontend code, logs, or source control.
      </p>
    </div>
  );
}

function ScopePicker({
  catalogue,
  selected,
  onChange,
  disabled,
}: {
  catalogue: ScopeCatalogue;
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const fullAccess = selected.includes(catalogue.full_access);
  const toggle = (id: string): void => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={fullAccess}
          disabled={disabled}
          onChange={() => onChange(fullAccess ? [] : [catalogue.full_access])}
        />
        <span>
          <span className="text-sm font-medium text-primary">Full access</span>
          <span className="block text-xs text-muted">
            Grants every current and future permission. Use only for trusted automation.
          </span>
        </span>
      </label>
      {catalogue.groups.map((group) => (
        <div key={group.group}>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{group.group}</p>
          <div className="grid gap-1.5">
            {group.scopes.map((id) => {
              const def = catalogue.scopes.find((s) => s.id === id);
              if (!def) return null;
              const checked = fullAccess || selected.includes(id);
              return (
                <label key={id} className="flex items-start gap-2 rounded px-2 py-1 hover:bg-raised">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checked}
                    disabled={disabled || fullAccess}
                    onChange={() => toggle(id)}
                  />
                  <span>
                    <span className="text-sm text-primary">
                      {def.label}
                      {def.sensitive ? <span className="ml-2 text-[11px] text-muted">sensitive</span> : null}
                    </span>
                    <span className="block text-xs text-muted">
                      <span className="font-mono">{id}</span> — {def.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AdminApiKeysPage(): React.JSX.Element {
  const [keys, setKeys] = React.useState<ApiKey[] | null>(null);
  const [pagination, setPagination] = React.useState<Pagination | null>(null);
  const [catalogue, setCatalogue] = React.useState<ScopeCatalogue | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();
  const [secret, setSecret] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | "active" | "expired" | "revoked">("all");

  const [showCreate, setShowCreate] = React.useState(false);
  const [createName, setCreateName] = React.useState("");
  const [createScopes, setCreateScopes] = React.useState<string[]>([]);
  const [createExpiry, setCreateExpiry] = React.useState("");
  const [createAllowlist, setCreateAllowlist] = React.useState("");

  const [editKey, setEditKey] = React.useState<ApiKey | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editScopes, setEditScopes] = React.useState<string[]>([]);
  const [editExpiry, setEditExpiry] = React.useState("");
  const [editAllowlist, setEditAllowlist] = React.useState("");

  const [rotateKey, setRotateKey] = React.useState<ApiKey | null>(null);
  const [rotateRevokeOld, setRotateRevokeOld] = React.useState(false);
  const [revokeKey, setRevokeKey] = React.useState<ApiKey | null>(null);

  const load = React.useCallback(async () => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("page_size", "25");
    if (search.trim()) params.set("q", search.trim());
    if (statusFilter !== "all") params.set("status", statusFilter);
    try {
      const data = await api.get<{ keys: ApiKey[]; pagination: Pagination }>(`/api/admin/api-keys?${params.toString()}`);
      setKeys(data.keys);
      setPagination(data.pagination);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load API keys.");
    }
  }, [page, search, statusFilter]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    api
      .get<ScopeCatalogue>("/api/admin/api-keys/scopes")
      .then(setCatalogue)
      .catch(() => setError("Unable to load the scope catalogue."));
  }, []);

  const resetCreate = (): void => {
    setCreateName("");
    setCreateScopes([]);
    setCreateExpiry("");
    setCreateAllowlist("");
  };

  const submitCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api.post<{ key: ApiKey; secret: string }>("/api/admin/api-keys", {
        name: createName.trim(),
        scopes: createScopes,
        expires_at: createExpiry ? new Date(createExpiry).toISOString() : null,
        ip_allowlist: parseAllowlist(createAllowlist),
      });
      setSecret(res.secret);
      setShowCreate(false);
      resetCreate();
      setNotice(`API key "${res.key.name}" created.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the API key.");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (key: ApiKey): void => {
    setEditKey(key);
    setEditName(key.name);
    setEditScopes(key.full_access ? [catalogue?.full_access ?? "*"] : key.scopes);
    setEditExpiry(toLocalInput(key.expires_at));
    setEditAllowlist(key.ip_allowlist.join(", "));
  };

  const submitEdit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editKey) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.patch(`/api/admin/api-keys/${editKey.id}`, {
        name: editName.trim(),
        scopes: editScopes,
        expires_at: editExpiry ? new Date(editExpiry).toISOString() : null,
        ip_allowlist: parseAllowlist(editAllowlist),
      });
      setEditKey(null);
      setNotice("API key updated.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the API key.");
    } finally {
      setBusy(false);
    }
  };

  const submitRotate = async (): Promise<void> => {
    if (!rotateKey) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.post<{ key: ApiKey; secret: string }>(`/api/admin/api-keys/${rotateKey.id}/rotate`, {
        revoke_old: rotateRevokeOld,
      });
      setSecret(res.secret);
      setRotateKey(null);
      setNotice(`Rotated "${rotateKey.name}". ${rotateRevokeOld ? "The previous secret was revoked." : "The previous secret remains valid until you revoke it."}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rotate the API key.");
    } finally {
      setBusy(false);
    }
  };

  const submitRevoke = async (): Promise<void> => {
    if (!revokeKey) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.del(`/api/admin/api-keys/${revokeKey.id}`);
      setRevokeKey(null);
      setNotice(`Revoked "${revokeKey.name}". Revocation applies immediately on the next request.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke the API key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="API Keys"
        subtitle="Create scoped credentials for the versioned /api/v1 API. Secrets are shown once and stored only as hashes."
        actions={
          <Button type="button" variant="ghost" onClick={() => setShowCreate((v) => !v)} aria-expanded={showCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" /> New key
          </Button>
        }
      />
      <InlineAlert message={error} />
      {notice ? (
        <div role="status" className="mb-4 rounded-md border border-highlight bg-raised px-3 py-2 text-sm text-primary">
          {notice}
        </div>
      ) : null}
      {secret ? <SecretPanel secret={secret} onDismiss={() => setSecret(null)} /> : null}

      {showCreate ? (
        <Card className="mb-5">
          <h2 className="mb-1 text-sm font-semibold text-primary">Create an API key</h2>
          <p className="mb-4 text-sm text-muted">
            Choose the narrowest set of scopes that still gets the job done. An administrator-issued key still needs the
            matching scope for every call, and it never gains administrator rights over the account that issued it.
          </p>
          <form onSubmit={submitCreate} className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="CI deploy"
                  required
                  minLength={2}
                  maxLength={80}
                  disabled={busy}
                />
              </div>
              <div>
                <Label htmlFor="key-expiry">Expires (optional)</Label>
                <Input
                  id="key-expiry"
                  type="datetime-local"
                  value={createExpiry}
                  onChange={(e) => setCreateExpiry(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div>
                <Label htmlFor="key-ip">IP allowlist (optional)</Label>
                <Input
                  id="key-ip"
                  value={createAllowlist}
                  onChange={(e) => setCreateAllowlist(e.target.value)}
                  placeholder="203.0.113.0/24, 198.51.100.7"
                  disabled={busy}
                />
              </div>
            </div>
            {catalogue ? (
              <ScopePicker catalogue={catalogue} selected={createScopes} onChange={setCreateScopes} disabled={busy} />
            ) : (
              <p className="text-sm text-muted">Loading scopes…</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || createScopes.length === 0}>
                {busy ? "Creating…" : "Create key"}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Label htmlFor="key-search">Search</Label>
          <Input
            id="key-search"
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
            placeholder="Name or key prefix"
          />
        </div>
        <div>
          <Label htmlFor="key-status">Status</Label>
          <select
            id="key-status"
            className="kct-input"
            value={statusFilter}
            onChange={(e) => {
              setPage(1);
              setStatusFilter(e.target.value as typeof statusFilter);
            }}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>
        <Button type="button" variant="ghost" onClick={() => void load()} aria-label="Refresh key list">
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
        </Button>
      </div>

      {keys === null && !error ? (
        <p className="text-sm text-muted" role="status">
          Loading API keys…
        </p>
      ) : keys && keys.length === 0 ? (
        <EmptyState
          title="No API keys yet"
          hint="Create a key to let scripts, CI pipelines, or integrations use the /api/v1 API with only the permissions you grant."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="kct-table kct-card w-full min-w-[860px] border-collapse overflow-hidden">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Prefix</th>
                <th scope="col">Scopes</th>
                <th scope="col">Status</th>
                <th scope="col">Expires</th>
                <th scope="col">Last used</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(keys ?? []).map((k) => (
                <tr key={k.id}>
                  <td>
                    <span className="font-medium text-primary">{k.name}</span>
                    {k.created_by_key ? (
                      <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">sub-key</span>
                    ) : null}
                    {k.created_by_name ? (
                      <span className="block text-xs text-muted">by {k.created_by_name}</span>
                    ) : null}
                  </td>
                  <td className="font-mono text-xs text-muted">{k.key_prefix}…</td>
                  <td className="text-muted">
                    {k.full_access ? (
                      <span className="rounded border border-mid px-1.5 py-0.5 text-[11px] text-primary">Full access</span>
                    ) : (
                      <span title={k.scopes.join(", ")}>{k.scopes.length} scope{k.scopes.length === 1 ? "" : "s"}</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={k.status} />
                  </td>
                  <td className="text-muted">{k.expires_at ? fmtTime(k.expires_at) : "Never"}</td>
                  <td className="text-muted">
                    {fmtTime(k.last_used_at)}
                    {k.last_used_endpoint ? (
                      <span className="block max-w-52 truncate font-mono text-xs" title={k.last_used_endpoint}>
                        {k.last_used_endpoint}
                      </span>
                    ) : null}
                    <span className="block text-xs">{k.use_count} call{k.use_count === 1 ? "" : "s"}</span>
                  </td>
                  <td>
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        className="px-2.5 py-1.5 text-xs"
                        onClick={() => openEdit(k)}
                        aria-label={`Edit ${k.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="px-2.5 py-1.5 text-xs"
                        onClick={() => {
                          setRotateKey(k);
                          setRotateRevokeOld(false);
                        }}
                        aria-label={`Rotate ${k.name}`}
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      {k.status === "revoked" ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          className="px-2.5 py-1.5 text-xs"
                          onClick={() => setRevokeKey(k)}
                          aria-label={`Revoke ${k.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.pages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm text-muted">
          <span>
            Page {pagination.page} of {pagination.pages} · {pagination.total} key{pagination.total === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              disabled={page >= pagination.pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {editKey && catalogue ? (
        <Modal title={`Edit — ${editKey.name}`} wide onClose={() => setEditKey(null)}>
          <form onSubmit={submitEdit} className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  minLength={2}
                  maxLength={80}
                  disabled={busy}
                />
              </div>
              <div>
                <Label htmlFor="edit-expiry">Expires</Label>
                <Input
                  id="edit-expiry"
                  type="datetime-local"
                  value={editExpiry}
                  onChange={(e) => setEditExpiry(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div>
                <Label htmlFor="edit-ip">IP allowlist</Label>
                <Input
                  id="edit-ip"
                  value={editAllowlist}
                  onChange={(e) => setEditAllowlist(e.target.value)}
                  placeholder="203.0.113.0/24"
                  disabled={busy}
                />
              </div>
            </div>
            <ScopePicker catalogue={catalogue} selected={editScopes} onChange={setEditScopes} disabled={busy} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditKey(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || editScopes.length === 0}>
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {rotateKey ? (
        <Modal title={`Rotate — ${rotateKey.name}`} onClose={() => setRotateKey(null)}>
          <p className="text-sm text-muted">
            Rotation creates a new secret for <span className="text-primary">{rotateKey.name}</span> with the same scopes.
            The new secret is shown once.
          </p>
          <label className="mt-4 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={rotateRevokeOld}
              onChange={(e) => setRotateRevokeOld(e.target.checked)}
            />
            <span className="text-sm text-primary">
              Revoke the previous secret immediately
              <span className="block text-xs text-muted">
                Leave unchecked to keep the old secret valid until you have deployed the new one.
              </span>
            </span>
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setRotateKey(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void submitRotate()} disabled={busy}>
              {busy ? "Rotating…" : "Rotate key"}
            </Button>
          </div>
        </Modal>
      ) : null}

      {revokeKey ? (
        <Modal title={`Revoke — ${revokeKey.name}`} onClose={() => setRevokeKey(null)}>
          <p className="text-sm text-muted">
            Revoke <span className="text-primary">{revokeKey.name}</span>? Requests using it will fail immediately with
            <span className="font-mono"> API_KEY_REVOKED</span>. Keys created by this key are revoked as well.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setRevokeKey(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" variant="danger" onClick={() => void submitRevoke()} disabled={busy}>
              {busy ? "Revoking…" : "Revoke key"}
            </Button>
          </div>
        </Modal>
      ) : null}

      <p className="mt-5 flex items-center gap-2 text-xs text-muted">
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
        API requests are documented at <a className="underline" href="/api/docs">/api/docs</a> and rate-limited per key
        (120 requests/minute; 20 for sensitive operations).
      </p>
    </div>
  );
}
