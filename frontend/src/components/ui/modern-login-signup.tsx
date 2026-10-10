import * as React from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button, FieldError, InlineAlert, Input, Label } from "@/components/ui/primitives";
import { BrandMark } from "@/components/ui/brand-mark";
import { useBranding } from "@/lib/branding";

/**
 * Monochrome animated dot-grid background.
 * Lightweight 2D-canvas equivalent of the supplied Three.js reference:
 * respects prefers-reduced-motion, handles canvas failure gracefully,
 * and cleans up animation frames + listeners on unmount.
 */
function DotGridBackground(): React.JSX.Element {
  const ref = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // graceful static fallback (CSS background remains)
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const gap = 26;
    let t = 0;
    const render = (): void => {
      t += 0.012;
      ctx.clearRect(0, 0, w, h);
      for (let y = gap / 2; y < h; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          const wave = 0.5 + 0.5 * Math.sin(x * 0.02 + t + y * 0.015);
          const alpha = 0.05 + wave * 0.12;
          ctx.beginPath();
          ctx.arc(x, y, 1.1, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(245,245,245,${alpha.toFixed(3)})`;
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      ctx.clearRect(0, 0, w, h);
    };
  }, []);

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden bg-base">
      <canvas ref={ref} className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-base" />
    </div>
  );
}

export interface LoginFormValues {
  email: string;
  password: string;
}

export function ModernLoginSignup({
  appName,
  error,
  loading,
  registrationEnabled,
  onSubmit,
}: {
  appName: string;
  error?: string;
  loading: boolean;
  registrationEnabled: boolean;
  onSubmit: (values: LoginFormValues) => void | Promise<void>;
}): React.JSX.Element {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const { logoUrl } = useBranding();

  const emailError = touched && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? "Enter a valid email address." : undefined;
  const passwordError = touched && password.length < 1 ? "Enter your password." : undefined;

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setTouched(true);
    if (emailError || passwordError) return;
    void onSubmit({ email: email.trim(), password });
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-base px-4">
      <DotGridBackground />
      <main className="relative w-full max-w-sm">
        <div className="kct-card p-7">
          <div className="mb-6 flex items-center gap-3">
            <BrandMark logoUrl={logoUrl} label={`${appName} logo`} />
            <div>
              <p className="text-base font-semibold tracking-tight text-logo">{appName}</p>
              <p className="text-xs text-muted">Infrastructure control panel</p>
            </div>
          </div>

          <h1 className="text-lg font-semibold tracking-tight text-primary">Sign in</h1>
          <p className="mb-5 mt-1 text-sm text-muted">Access your virtual servers.</p>

          <form onSubmit={submit} noValidate className="space-y-4">
            <div>
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                aria-invalid={Boolean(emailError)}
                aria-describedby={emailError ? "email-error" : undefined}
                required
              />
              <span id="email-error">
                <FieldError message={emailError} />
              </span>
            </div>

            <div>
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  aria-invalid={Boolean(passwordError)}
                  required
                  className="pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={loading}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-primary"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <FieldError message={passwordError} />
            </div>

            <InlineAlert message={error} />

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>

          {!registrationEnabled ? (
            <p className="mt-5 text-center text-xs text-muted">Account creation is disabled. Contact your administrator.</p>
          ) : null}
        </div>
        <p className="mt-4 text-center text-xs text-muted">Self-hosted · monochromatic · no tracking</p>
      </main>
    </div>
  );
}
