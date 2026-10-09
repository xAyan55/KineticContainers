import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "@/lib/api";
import { avatarDataUri } from "@/lib/avatar";
import { Button, Card, InlineAlert, Input, Label, PageHeader, StatusBadge } from "@/components/ui/primitives";

interface Detail {
  user: { id: string; email: string; name: string; role: string; status: string; avatar_seed: string; created_at: string };
  instances: { id: string; name: string; container_id: string; status: string }[];
}

export function AdminUserDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [msg, setMsg] = React.useState<string | undefined>();
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("user");
  const [status, setStatus] = React.useState("active");
  const [newPassword, setNewPassword] = React.useState("");
  const [transferTo, setTransferTo] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const d = await api.get<Detail>(`/api/admin/users/${id}`);
      setDetail(d);
      setName(d.user.name);
      setRole(d.user.role);
      setStatus(d.user.status);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load user.");
    }
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    setError(undefined);
    setMsg(undefined);
    try {
      const d = await api.patch<{ user: Detail["user"] }>(`/api/admin/users/${id}`, { name, role, status });
      setMsg("User updated.");
      setDetail((prev) => (prev ? { ...prev, user: { ...prev.user, ...d.user } } : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed.");
    }
  };

  const resetPw = async (): Promise<void> => {
    if (!window.confirm("Reset this user's password? Their sessions will be revoked.")) return;
    setError(undefined);
    setMsg(undefined);
    try {
      await api.post(`/api/admin/users/${id}/reset-password`, { new_password: newPassword });
      setNewPassword("");
      setMsg("Password reset. Share the new password through a secure channel.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reset failed.");
    }
  };

  const toggleStatus = async (): Promise<void> => {
    if (!window.confirm(status === "active" ? "Disable this account? They will be signed out." : "Re-enable this account?")) return;
    setError(undefined);
    try {
      const next = status === "active" ? "disabled" : "active";
      await api.patch(`/api/admin/users/${id}`, { status: next });
      setStatus(next);
      setMsg(next === "disabled" ? "Account disabled. Owned instances are retained." : "Account re-enabled.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Operation failed.");
    }
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm("Delete this account? Accounts owning instances cannot be deleted.")) return;
    setError(undefined);
    try {
      await api.del(`/api/admin/users/${id}`);
      navigate("/admin/users");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed.");
    }
  };

  if (!detail) return <div><PageHeader title="User details" /><p className="text-sm text-muted" role="status">Loading…</p><InlineAlert message={error} /></div>;

  return (
    <div>
      <PageHeader title={detail.user.name} subtitle={detail.user.email} />
      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <div className="mb-4 flex items-center gap-3">
            <img src={avatarDataUri(detail.user.avatar_seed || detail.user.email)} alt="" width={48} height={48} className="rounded-full border border-border" />
            <div className="text-sm"><StatusBadge status={detail.user.status} /> <span className="ml-2 text-muted">{detail.user.role}</span></div>
          </div>
          <div className="grid gap-3">
            <div><Label htmlFor="u-name">Display name</Label><Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div>
              <Label htmlFor="u-role">Role</Label>
              <select id="u-role" value={role} onChange={(e) => setRole(e.target.value)} className="kct-input">
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void save()}>Save</Button>
              <Button type="button" variant="ghost" onClick={() => void toggleStatus()}>{status === "active" ? "Disable account" : "Enable account"}</Button>
              <Button type="button" variant="ghost" onClick={() => void remove()}>Delete…</Button>
            </div>
          </div>
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-primary">Assigned instances ({detail.instances.length})</h2>
            {detail.instances.length === 0 ? (
              <p className="text-sm text-muted">No instances assigned. Ownership changes never destroy containers implicitly.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {detail.instances.map((i) => (
                  <li key={i.id} className="flex items-center justify-between rounded border border-border px-3 py-2">
                    <span className="text-primary">{i.name} <span className="ml-1 font-mono text-xs text-muted">{i.container_id}</span></span>
                    <StatusBadge status={i.status} />
                  </li>
                ))}
              </ul>
            )}
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!window.confirm("Transfer all instances to another user?")) return;
                api.post(`/api/admin/users/${id}/transfer-instances`, { target_user_id: transferTo })
                  .then(() => {
                    setMsg("Instances transferred.");
                    setTransferTo("");
                    void load();
                  })
                  .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Transfer failed."));
              }}
            >
              <label htmlFor="transfer" className="sr-only">Target user id</label>
              <Input id="transfer" placeholder="Target user id…" value={transferTo} onChange={(e) => setTransferTo(e.target.value)} />
              <Button type="submit" variant="ghost">Transfer</Button>
            </form>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-primary">Reset password</h2>
            <div className="flex gap-2">
              <label htmlFor="new-pw" className="sr-only">New password</label>
              <Input id="new-pw" type="password" autoComplete="new-password" placeholder="Min. 10 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              <Button type="button" variant="ghost" onClick={() => void resetPw()}>Reset</Button>
            </div>
            <p className="mt-2 text-xs text-muted">Existing passwords are never displayed. Resets revoke all sessions.</p>
          </Card>
        </div>
      </div>
      {msg ? <div role="status" className="mt-4 rounded-md border border-highlight bg-raised px-3 py-2 text-sm text-primary">{msg}</div> : null}
      <div className="mt-4"><InlineAlert message={error} /></div>
    </div>
  );
}
