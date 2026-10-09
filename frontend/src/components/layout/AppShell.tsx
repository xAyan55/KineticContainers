import * as React from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, LogOut, Server, Settings, ShieldCheck, UserRound } from "lucide-react";
import { useAuth } from "@/features/auth/AuthContext";
import { avatarDataUri } from "@/lib/avatar";
import { cn } from "@/lib/utils";

function Brand({ appName }: { appName: string }): React.JSX.Element {
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label={`${appName} home`}>
      <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-raised" aria-hidden="true">
        <Server className="h-4 w-4 text-logo" />
      </span>
      <span className="text-sm font-semibold tracking-tight text-logo">{appName}</span>
    </Link>
  );
}

export function AppShell({ appName, children }: { appName: string; children: React.ReactNode }): React.JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = React.useState(false);

  const onLogout = async (): Promise<void> => {
    await logout();
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-base text-primary">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:rounded focus:bg-raised focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
          <Brand appName={appName} />
          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            <NavLink to="/" end className={({ isActive }) => cn("rounded-md px-3 py-1.5 text-sm", isActive ? "bg-raised text-primary" : "text-muted hover:text-primary")}>
              <span className="inline-flex items-center gap-2"><LayoutDashboard className="h-4 w-4" aria-hidden="true" />Dashboard</span>
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => cn("rounded-md px-3 py-1.5 text-sm", isActive ? "bg-raised text-primary" : "text-muted hover:text-primary")}>
              <span className="inline-flex items-center gap-2"><UserRound className="h-4 w-4" aria-hidden="true" />Profile</span>
            </NavLink>
            {user?.role === "admin" ? (
              <NavLink to="/admin" className={({ isActive }) => cn("rounded-md px-3 py-1.5 text-sm", isActive ? "bg-raised text-primary" : "text-muted hover:text-primary")}>
                <span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden="true" />Admin</span>
              </NavLink>
            ) : null}
          </nav>
          <div className="flex items-center gap-2">
            {user ? (
              <>
                <img src={avatarDataUri(user.avatar_seed || user.email)} alt="" width={28} height={28} className="hidden rounded-full border border-border sm:block" />
                <span className="hidden max-w-40 truncate text-sm text-muted sm:block">{user.name}</span>
              </>
            ) : null}
            <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen} aria-label="Open navigation menu" className="rounded-md border border-border px-2.5 py-1.5 text-sm text-muted hover:text-primary md:hidden">
              Menu
            </button>
            <button type="button" onClick={() => void onLogout()} className="hidden items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm text-muted hover:text-primary md:inline-flex">
              <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
            </button>
          </div>
        </div>
        {menuOpen ? (
          <nav aria-label="Mobile" className="border-t border-border px-4 py-2 md:hidden">
            <div className="flex flex-col gap-1 text-sm">
              <NavLink to="/" end onClick={() => setMenuOpen(false)} className="rounded px-2 py-2 text-muted hover:bg-raised hover:text-primary">Dashboard</NavLink>
              <NavLink to="/profile" onClick={() => setMenuOpen(false)} className="rounded px-2 py-2 text-muted hover:bg-raised hover:text-primary">Profile</NavLink>
              {user?.role === "admin" ? <NavLink to="/admin" onClick={() => setMenuOpen(false)} className="rounded px-2 py-2 text-muted hover:bg-raised hover:text-primary">Admin</NavLink> : null}
              <button type="button" onClick={() => void onLogout()} className="rounded px-2 py-2 text-left text-muted hover:bg-raised hover:text-primary">Sign out</button>
            </div>
          </nav>
        ) : null}
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6">
        {children}
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted">
        <p>{appName} · self-hosted infrastructure panel</p>
      </footer>
    </div>
  );
}

export function AdminLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
      <aside aria-label="Administration" className="lg:sticky lg:top-[72px] lg:self-start">
        <nav className="kct-card flex gap-1 overflow-x-auto p-2 lg:flex-col" aria-label="Admin sections">
          {[
            { to: "/admin", end: true, label: "Overview", Icon: LayoutDashboard },
            { to: "/admin/users", end: false, label: "Users", Icon: UserRound },
            { to: "/admin/create", end: true, label: "Create", Icon: Server },
            { to: "/admin/settings", end: true, label: "Settings", Icon: Settings },
          ].map(({ to, end, label, Icon }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cn("flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm", isActive ? "bg-raised text-primary" : "text-muted hover:text-primary")}>
              <Icon className="h-4 w-4" aria-hidden="true" /> {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <section aria-label="Admin content" className="min-w-0">{children}</section>
    </div>
  );
}
