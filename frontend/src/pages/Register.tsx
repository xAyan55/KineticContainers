import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button, FieldError, InlineAlert, Input, Label } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";

export function RegisterPage({ appName }: { appName: string }): React.JSX.Element {
  const navigate = useNavigate();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(false);
  const [allowed, setAllowed] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    api.get<{ settings: Record<string, string> }>("/api/settings/public")
      .then((d) => setAllowed(d.settings.registration_enabled === "true"))
      .catch(() => setAllowed(false));
  }, []);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    try {
      await api.post("/api/auth/register", { name, email, password });
      navigate("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed.");
    } finally {
      setLoading(false);
    }
  };

  if (allowed === null) return <div className="flex min-h-screen items-center justify-center bg-base text-sm text-muted">Loading…</div>;
  if (!allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base px-4">
        <div className="kct-card max-w-sm p-6 text-center">
          <p className="text-sm font-semibold text-primary">Registration is disabled</p>
          <p className="mt-1 text-sm text-muted">Ask your administrator for an account.</p>
          <Link to="/login" className="mt-4 inline-block text-sm text-primary underline">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-4">
      <main className="kct-card w-full max-w-sm p-7">
        <h1 className="text-lg font-semibold text-primary">Create account</h1>
        <p className="mb-5 mt-1 text-sm text-muted">{appName} self-registration.</p>
        <form onSubmit={submit} className="space-y-4">
          <div><Label htmlFor="r-name">Display name</Label><Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} disabled={loading} /></div>
          <div><Label htmlFor="r-email">Email</Label><Input id="r-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={loading} /></div>
          <div>
            <Label htmlFor="r-pass">Password</Label>
            <Input id="r-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={loading} />
            <FieldError message={password && password.length < 10 ? "Use at least 10 characters." : undefined} />
          </div>
          <InlineAlert message={error} />
          <Button type="submit" disabled={loading} className="w-full">{loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : "Create account"}</Button>
        </form>
        <Link to="/login" className="mt-4 block text-center text-sm text-muted hover:text-primary">Back to sign in</Link>
      </main>
    </div>
  );
}
