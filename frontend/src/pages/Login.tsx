import * as React from "react";
import { useNavigate } from "react-router-dom";
import { ModernLoginSignup } from "@/components/ui/modern-login-signup";
import { useAuth } from "@/features/auth/AuthContext";
import { ApiError, api } from "@/lib/api";

export function LoginPage({ appName }: { appName: string }): React.JSX.Element {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(false);
  const [registrationEnabled, setRegistrationEnabled] = React.useState(false);

  React.useEffect(() => {
    api.get<{ settings: Record<string, string> }>("/api/settings/public")
      .then((d) => setRegistrationEnabled(d.settings.registration_enabled === "true"))
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  const onSubmit = async ({ email, password }: { email: string; password: string }): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return <ModernLoginSignup appName={appName} error={error} loading={loading} registrationEnabled={registrationEnabled} onSubmit={onSubmit} />;
}
