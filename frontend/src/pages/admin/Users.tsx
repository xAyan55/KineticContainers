import * as React from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { avatarDataUri } from "@/lib/avatar";
import { EmptyState, InlineAlert, Input, PageHeader, StatusBadge } from "@/components/ui/primitives";

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

  return (
    <div>
      <PageHeader title="Users" subtitle="Search, inspect, and administer accounts." />
      <form
        className="mb-4 flex gap-2"
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
          <Input id="user-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email…" className="pl-9" />
        </div>
        <button type="submit" className="kct-btn-ghost">Search</button>
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
