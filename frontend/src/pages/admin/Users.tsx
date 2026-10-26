import * as React from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { avatarDataUri } from "@/lib/avatar";
import { Button, Card, EmptyState, InlineAlert, Input, Label, PageHeader, StatusBadge } from "@/components/ui/primitives";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  avatar_seed: string;
  created_at: string;
  instance_count: number;
}

export function AdminUsersPage(): React.JSX.Element {
  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [q, setQ] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();
  const pageSize = 25;
  const [creating, setCreating] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | undefined>();
  const [form, setForm] = React.useState({ name: "", email: "", password: "", role: "user" });

  const load = React.useCallback(async (p: number, search: string) => {
    try {
      const data = await api.get<{ users: AdminUser[]; pagination: { total: number } }>(
        `/api/admin/users?page=${p}&page_size=${pageSize}&q=${encodeURIComponent(search)}`
      );
      setUsers(data.users);
      setTotal(data.pagination.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load users.");
    }
  }, []);

  React.useEffect(() => {
    void load(page, query);
  }, [load, page, query]);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  const createUser = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.post("/api/admin/users", {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
      });
      setNotice(`Created ${form.email.trim()}.`);
      setForm({ name: "", email: "", password: "", role: "user" });
      setCreating(false);
      setPage(1);
      setQuery("");
      setQ("");
      await load(1, "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the user.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Search, inspect, and administer accounts."
        actions={
          <Button type="button" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "New user"}
          </Button>
        }
      />
      {notice ? (
        <div role="status" className="mb-4 rounded-md border border-border bg-raised px-3 py-2 text-sm text-primary">
          {notice}
        </div>
      ) : null}
      {creating ? (
        <Card className="mb-4">
          <h2 className="mb-4 text-sm font-semibold text-primary">Create user</h2>
          <form onSubmit={(e) => void createUser(e)} className="grid max-w-xl gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="nu-name">Name</Label>
              <Input id="nu-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={1} maxLength={120} disabled={busy} />
            </div>
            <div>
              <Label htmlFor="nu-email">Email</Label>
              <Input id="nu-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required disabled={busy} />
            </div>
            <div>
              <Label htmlFor="nu-password">Password</Label>
              <Input id="nu-password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={10} maxLength={256} disabled={busy} autoComplete="new-password" />
            </div>
            <div>
              <Label htmlFor="nu-role">Role</Label>
              <select id="nu-role" className="kct-input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} disabled={busy}>
                <option value="user">User</option>
                <option value="admin">Administrator</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create user"}</Button>
            </div>
          </form>
        </Card>
      ) : null}
      <form
        className="mb-4 flex flex-wrap sm:flex-nowrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q.trim());
        }}
        role="search"
      >
        <label htmlFor="user-search" className="sr-only">Search users</label>
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input id="user-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email…" className="!pl-9" />
        </div>
        <button type="submit" className="kct-btn-ghost w-full sm:w-auto">Search</button>
      </form>

      <InlineAlert message={error} />
      {users.length === 0 ? (
        <EmptyState title="No users found" hint="Try a different search, or invite users once registration policy allows." />
      ) : (
        <div className="overflow-x-auto">
          <table className="kct-table kct-card w-full min-w-[820px] border-collapse overflow-hidden">
            <thead>
              <tr><th scope="col">User</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Instances</th><th scope="col">Created</th><th scope="col">Status</th><th scope="col">Details</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="flex items-center gap-2">
                      <img src={avatarDataUri(u.avatar_seed || u.email)} alt="" width={24} height={24} className="rounded-full border border-border" />
                      <span className="font-medium text-primary">{u.name}</span>
                    </span>
                  </td>
                  <td className="text-muted">{u.email}</td>
                  <td className="text-muted">{u.role}</td>
                  <td className="text-muted">{u.instance_count}</td>
                  <td className="text-muted">{new Date(u.created_at).toLocaleDateString()}</td>
                  <td><StatusBadge status={u.status} /></td>
                  <td><Link to={`/admin/users/${u.id}`} className="text-sm text-primary underline">View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 text-sm text-muted" aria-label="Pagination">
        <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="kct-btn-ghost px-3 py-1.5 disabled:opacity-50">Previous</button>
        <span aria-live="polite">Page {page} of {pages} · {total} users</span>
        <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="kct-btn-ghost px-3 py-1.5 disabled:opacity-50">Next</button>
      </div>
    </div>
  );
}
