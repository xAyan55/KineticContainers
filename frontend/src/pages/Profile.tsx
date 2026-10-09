import * as React from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/features/auth/AuthContext";
import { ApiError, api, type SessionUser } from "@/lib/api";
import { avatarDataUri } from "@/lib/avatar";
import { Button, Card, InlineAlert, Input, Label, PageHeader } from "@/components/ui/primitives";

export function ProfilePage(): React.JSX.Element {
  const { user, setUser } = useAuth();
  const [name, setName] = React.useState(user?.name ?? "");
  const [email, setEmail] = React.useState(user?.email ?? "");
  const [seed, setSeed] = React.useState(user?.avatar_seed ?? "");
  const [currentPw, setCurrentPw] = React.useState("");
  const [newPw, setNewPw] = React.useState("");
  const [msg, setMsg] = React.useState<string | undefined>();
  const [error, setError] = React.useState<string | undefined>();
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
    setSeed(user?.avatar_seed ?? "");
  }, [user]);

  const saveProfile = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    setMsg(undefined);
    try {
      const data = await api.patch<{ user: SessionUser }>("/api/me", {
        name: name.trim(),
        email: email.trim(),
        avatar_seed: seed.trim() || undefined,
      });
      setUser(data.user);
      setMsg("Profile saved successfully.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save profile.");
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    setMsg(undefined);
    try {
      await api.post("/api/me/password", { current_password: currentPw, new_password: newPw });
      setCurrentPw("");
      setNewPw("");
      setMsg("Password changed successfully.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change password.");
    } finally {
      setSaving(false);
    }
  };

  if (!user) return <p className="text-sm text-muted">Loading…</p>;
  const previewSeed = seed.trim() || user.email;

  return (
    <div>
      <PageHeader title="Profile" subtitle="Manage your display name, email, avatar, and password." />
      <div className="grid gap-5 md:grid-cols-[280px_1fr]">
        <Card className="flex flex-col items-center gap-3 text-center">
          <img src={avatarDataUri(previewSeed)} alt={`Avatar for ${user.name}`} width={112} height={112} className="rounded-full border border-border" />
          <div>
            <p className="text-sm font-semibold text-primary">{user.name}</p>
            <p className="text-xs text-muted">{user.email}</p>
          </div>
          <p className="text-xs text-muted">Avatar style: Lorelei (DiceBear), generated locally from your account seed.</p>
          <p className="text-xs text-muted">Member since {new Date(user.created_at).toLocaleDateString()}</p>
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <h2 className="mb-4 text-sm font-semibold text-primary">Account details</h2>
            <form onSubmit={saveProfile} className="grid gap-4">
              <div><Label htmlFor="p-name">Display name</Label><Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required disabled={saving} /></div>
              <div><Label htmlFor="p-email">Email address</Label><Input id="p-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={saving} /></div>
              <div>
                <Label htmlFor="p-seed">Avatar seed</Label>
                <Input id="p-seed" value={seed} onChange={(e) => setSeed(e.target.value)} maxLength={120} disabled={saving} aria-describedby="seed-hint" />
                <p id="seed-hint" className="mt-1 text-xs text-muted">Change the seed to get a different generated avatar. Defaults to your email.</p>
              </div>
              <div><Button type="submit" disabled={saving}>{saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : "Save changes"}</Button></div>
            </form>
          </Card>

          <Card>
            <h2 className="mb-4 text-sm font-semibold text-primary">Change password</h2>
            <form onSubmit={changePassword} className="grid gap-4">
              <div><Label htmlFor="p-cur">Current password</Label><Input id="p-cur" type="password" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} required disabled={saving} /></div>
              <div><Label htmlFor="p-new">New password</Label><Input id="p-new" type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required disabled={saving} /></div>
              <div><Button type="submit" variant="ghost" disabled={saving}>{saving ? "Updating…" : "Update password"}</Button></div>
            </form>
          </Card>

          {msg ? <div role="status" className="rounded-md border border-highlight bg-raised px-3 py-2 text-sm text-primary">{msg}</div> : null}
          <InlineAlert message={error} />
        </div>
      </div>
    </div>
  );
}
