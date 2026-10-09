import * as React from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import {
  ChevronsLeft,
  ChevronsRight,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Server,
  Settings,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/features/auth/AuthContext";
import { avatarDataUri } from "@/lib/avatar";
import { cn } from "@/lib/utils";

interface NavEntry {
  to: string;
  end?: boolean;
  label: string;
  Icon: LucideIcon;
}

// The dashboard IS the user's VPS list — one entry, no duplicates.
const MAIN_NAV: NavEntry[] = [{ to: "/", end: true, label: "Dashboard", Icon: LayoutDashboard }];

const ACCOUNT_NAV: NavEntry[] = [{ to: "/profile", end: true, label: "Profile", Icon: UserRound }];

const ADMIN_NAV: NavEntry[] = [
  { to: "/admin", end: true, label: "Overview", Icon: Gauge },
  { to: "/admin/users", label: "Users", Icon: Users },
  { to: "/admin/create", end: true, label: "Create VPS", Icon: Plus },
  { to: "/admin/settings", end: true, label: "Settings", Icon: Settings },
];

function NavItem({
  entry,
  collapsed,
  onNavigate,
}: {
  entry: NavEntry;
  collapsed: boolean;
  onNavigate?: () => void;
}): React.JSX.Element {
  const { to, end, label, Icon } = entry;
  return (
    <li>
      <NavLink
        to={to}
        end={end}
        onClick={onNavigate}
        aria-label={collapsed ? label : undefined}
        data-tip={collapsed ? label : undefined}
        className={({ isActive }) =>
          cn(
            "kct-tip flex items-center gap-3 rounded-md text-sm transition-colors",
            collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2",
            isActive ? "bg-mid font-medium text-white" : "text-muted hover:bg-raised hover:text-primary"
          )
        }
      >
        <Icon className="h-[1.125rem] w-[1.125rem] shrink-0" aria-hidden="true" />
        {collapsed ? null : <span className="truncate">{label}</span>}
      </NavLink>
    </li>
  );
}

function NavSection({
  title,
  collapsed,
  children,
}: {
  title: string;
  collapsed: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      {collapsed ? null : (
        <p aria-hidden="true" className="px-3 pb-1.5 pt-4 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted">
          {title}
        </p>
      )}
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function SidebarBody({
  appName,
  collapsed,
  isAdmin,
  onToggleCollapse,
  onNavigate,
  showToggle,
}: {
  appName: string;
  collapsed: boolean;
  isAdmin: boolean;
  onToggleCollapse: () => void;
  onNavigate?: () => void;
  showToggle: boolean;
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex items-center border-b border-border", collapsed ? "flex-col gap-2 py-4" : "h-14 justify-between px-4")}>
        <Link
          to="/"
          onClick={onNavigate}
          aria-label={`${appName} home`}
          className={cn("flex min-w-0 items-center gap-2.5", collapsed && "justify-center")}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-raised" aria-hidden="true">
            <Server className="h-4 w-4 text-logo" />
          </span>
          {collapsed ? null : <span className="truncate text-sm font-semibold tracking-tight text-logo">{appName}</span>}
        </Link>
        {showToggle ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-primary"
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" aria-hidden="true" /> : <ChevronsLeft className="h-4 w-4" aria-hidden="true" />}
          </button>
        ) : null}
      </div>

      <nav aria-label="Primary" className="kct-scroll flex-1 overflow-y-auto px-3 py-2">
        <NavSection title="Main" collapsed={collapsed}>
          {MAIN_NAV.map((entry) => (
            <NavItem key={entry.label} entry={entry} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </NavSection>
        <NavSection title="Account" collapsed={collapsed}>
          {ACCOUNT_NAV.map((entry) => (
            <NavItem key={entry.label} entry={entry} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </NavSection>
        {isAdmin ? (
          <NavSection title="Administration" collapsed={collapsed}>
            {ADMIN_NAV.map((entry) => (
              <NavItem key={entry.label} entry={entry} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </NavSection>
        ) : null}
      </nav>

      <SidebarFooter collapsed={collapsed} onNavigate={onNavigate} />
    </div>
  );
}

function SidebarFooter({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }): React.JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  if (!user) return <div className="border-t border-border p-3" />;

  const onLogout = async (): Promise<void> => {
    setMenuOpen(false);
    onNavigate?.();
    await logout();
    navigate("/login");
  };

  const goProfile = (): void => {
    setMenuOpen(false);
    onNavigate?.();
    navigate("/profile");
  };

  return (
    <div className="relative border-t border-border p-3" ref={menuRef}>
      {menuOpen ? (
        <div role="menu" aria-label="Account" className="absolute bottom-full left-3 z-30 mb-2 w-52 overflow-hidden rounded-md border border-border bg-raised shadow-none">
          <button
            type="button"
            role="menuitem"
            onClick={goProfile}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-muted hover:bg-mid hover:text-primary"
          >
            <UserRound className="h-4 w-4" aria-hidden="true" /> Profile
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void onLogout()}
            className="flex w-full items-center gap-2.5 border-t border-border px-3 py-2 text-left text-sm text-muted hover:bg-mid hover:text-primary"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" /> Logout
          </button>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={collapsed ? `Account: ${user.name}` : undefined}
        data-tip={collapsed ? user.name : undefined}
        className={cn(
          "kct-tip flex w-full items-center gap-2.5 rounded-md p-1.5 hover:bg-raised",
          collapsed && "justify-center"
        )}
      >
        <img src={avatarDataUri(user.avatar_seed || user.email)} alt="" width={28} height={28} className="shrink-0 rounded-full border border-border" />
        {collapsed ? null : (
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-medium text-primary">{user.name}</span>
            <span className="block truncate text-xs text-muted">{user.email}</span>
          </span>
        )}
      </button>
    </div>
  );
}

export function Sidebar({
  appName,
  collapsed,
  onToggleCollapse,
}: {
  appName: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}): React.JSX.Element {
  const { user } = useAuth();
  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 border-r border-border bg-surface transition-[width] duration-200 lg:block",
        collapsed ? "w-[4.25rem]" : "w-60"
      )}
    >
      <SidebarBody
        appName={appName}
        collapsed={collapsed}
        isAdmin={user?.role === "admin"}
        onToggleCollapse={onToggleCollapse}
        showToggle
      />
    </aside>
  );
}

export function MobileSidebar({
  appName,
  open,
  onClose,
}: {
  appName: string;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { user } = useAuth();
  const closeRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
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
  }, [open, onClose]);

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-black/70 transition-opacity duration-200 lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-border bg-surface transition-transform duration-200 lg:hidden",
          open ? "translate-x-0" : "invisible -translate-x-full"
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="flex items-center gap-2.5" aria-hidden="true">
            <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-raised">
              <Server className="h-4 w-4 text-logo" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-logo">{appName}</span>
          </span>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-primary"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <SidebarBody appName={appName} collapsed={false} isAdmin={user?.role === "admin"} onToggleCollapse={onClose} showToggle={false} onNavigate={onClose} />
        </div>
      </aside>
    </>
  );
}

export function SidebarMenuButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open navigation"
      className="rounded-md p-2 text-muted hover:bg-raised hover:text-primary lg:hidden"
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
