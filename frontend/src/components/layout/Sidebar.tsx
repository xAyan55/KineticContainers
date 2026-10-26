import * as React from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import {
  ChevronsLeft,
  ChevronsRight,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
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
import { BrandMark } from "@/components/ui/brand-mark";
import { AnimatePresence, motion } from "framer-motion";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

interface NavEntry {
  to: string;
  end?: boolean;
  label: string;
  Icon: LucideIcon;
}

const MAIN_NAV: NavEntry[] = [{ to: "/", end: true, label: "Dashboard", Icon: LayoutDashboard }];

const ACCOUNT_NAV: NavEntry[] = [{ to: "/profile", end: true, label: "Profile", Icon: UserRound }];

const ADMIN_NAV: NavEntry[] = [
  { to: "/admin", end: true, label: "Overview", Icon: Gauge },
  { to: "/admin/nodes", end: true, label: "Nodes", Icon: Network },
  { to: "/admin/instances", label: "Instances", Icon: Server },
  { to: "/admin/users", label: "Users", Icon: Users },
  { to: "/admin/create", end: true, label: "Create VPS", Icon: Plus },
  { to: "/admin/api-keys", end: true, label: "API Keys", Icon: KeyRound },
  { to: "/admin/settings", end: true, label: "Settings", Icon: Settings },
];

function NavItem({
  entry,
  isOpen,
  onNavigate,
}: {
  entry: NavEntry;
  isOpen: boolean;
  onNavigate?: () => void;
}): React.JSX.Element {
  const { to, end, label, Icon } = entry;
  return (
    <li>
      <NavLink
        to={to}
        end={end}
        onClick={onNavigate}
        aria-label={!isOpen ? label : undefined}
        data-tip={!isOpen ? label : undefined}
        className={({ isActive }) =>
          cn(
            "kct-tip group/sidebar relative flex items-center gap-3 rounded-md text-sm transition-colors duration-150",
            !isOpen ? "justify-center px-0 py-2.5" : "px-3 py-2",
            isActive
              ? "bg-mid font-medium text-primary shadow-sm"
              : "text-muted hover:bg-raised hover:text-primary"
          )
        }
      >
        <Icon className="h-4 w-4 shrink-0 transition-transform duration-150 group-hover/sidebar:scale-110" aria-hidden="true" />
        <motion.span
          animate={{
            display: isOpen ? "inline-block" : "none",
            opacity: isOpen ? 1 : 0,
            x: isOpen ? 0 : -4,
          }}
          transition={{ duration: 0.18 }}
          className="truncate text-sm whitespace-pre group-hover/sidebar:translate-x-0.5 transition-transform duration-150"
        >
          {label}
        </motion.span>
      </NavLink>
    </li>
  );
}

function NavSection({
  title,
  isOpen,
  children,
}: {
  title: string;
  isOpen: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="py-1">
      <motion.p
        animate={{
          display: isOpen ? "block" : "none",
          opacity: isOpen ? 1 : 0,
        }}
        transition={{ duration: 0.15 }}
        aria-hidden="true"
        className="px-3 pb-1.5 pt-3 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted truncate"
      >
        {title}
      </motion.p>
      {!isOpen && <div className="my-2 border-t border-border/40 mx-2" />}
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function SidebarFooterInner({ isOpen, onNavigate }: { isOpen: boolean; onNavigate?: () => void }): React.JSX.Element {
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
    <div className="relative border-t border-border p-2.5" ref={menuRef}>
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            role="menu"
            aria-label="Account"
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full left-2 z-50 mb-2 w-52 overflow-hidden rounded-md border border-border bg-raised shadow-xl"
          >
            <button
              type="button"
              role="menuitem"
              onClick={goProfile}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-muted hover:bg-mid hover:text-primary transition-colors cursor-pointer"
            >
              <UserRound className="h-4 w-4" aria-hidden="true" /> Profile
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void onLogout()}
              className="flex w-full items-center gap-2.5 border-t border-border px-3 py-2 text-left text-sm text-muted hover:bg-mid hover:text-primary transition-colors cursor-pointer"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" /> Logout
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={!isOpen ? `Account: ${user.name}` : undefined}
        data-tip={!isOpen ? user.name : undefined}
        className={cn(
          "kct-tip flex w-full items-center gap-2.5 rounded-md p-1.5 hover:bg-raised transition-colors cursor-pointer",
          !isOpen && "justify-center"
        )}
      >
        <img
          src={avatarDataUri(user.avatar_seed || user.email)}
          alt=""
          width={28}
          height={28}
          className="shrink-0 rounded-full border border-border"
        />
        <motion.span
          animate={{
            display: isOpen ? "block" : "none",
            opacity: isOpen ? 1 : 0,
          }}
          transition={{ duration: 0.18 }}
          className="min-w-0 flex-1 text-left truncate"
        >
          <span className="block truncate text-sm font-medium text-primary">{user.name}</span>
          <span className="block truncate text-xs text-muted">{user.email}</span>
        </motion.span>
      </button>
    </div>
  );
}

export function Sidebar({
  appName,
  logoUrl,
  collapsed,
  onToggleCollapse,
}: {
  appName: string;
  logoUrl?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}): React.JSX.Element {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [hovered, setHovered] = React.useState(false);

  // If collapsed is false, it's pinned open. If collapsed is true, it expands temporarily on hover!
  const isExpanded = !collapsed || hovered;

  return (
    <motion.aside
      aria-label="Sidebar"
      animate={{
        width: isExpanded ? "260px" : "64px",
      }}
      transition={{ duration: 0.22, ease: "easeInOut" }}
      onMouseEnter={() => {
        if (collapsed) setHovered(true);
      }}
      onMouseLeave={() => {
        if (collapsed) setHovered(false);
      }}
      className="sticky top-0 hidden h-screen shrink-0 border-r border-border bg-surface lg:flex lg:flex-col z-30 overflow-hidden"
    >
      {/* Sidebar Header */}
      <div className={cn("flex items-center border-b border-border h-14", !isExpanded ? "justify-center px-0" : "justify-between px-3.5")}>
        <Link
          to="/"
          aria-label={`${appName} home`}
          className={cn("flex min-w-0 items-center gap-2.5", !isExpanded && "justify-center")}
        >
          <BrandMark logoUrl={logoUrl} label={`${appName} logo`} />
          <motion.span
            animate={{
              display: isExpanded ? "inline-block" : "none",
              opacity: isExpanded ? 1 : 0,
            }}
            transition={{ duration: 0.18 }}
            className="truncate text-sm font-semibold tracking-tight text-logo whitespace-pre"
          >
            {appName}
          </motion.span>
        </Link>
        {isExpanded && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Pin sidebar open" : "Collapse sidebar"}
            className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-primary transition-colors cursor-pointer"
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" aria-hidden="true" /> : <ChevronsLeft className="h-4 w-4" aria-hidden="true" />}
          </button>
        )}
      </div>

      {/* Primary Navigation */}
      <nav aria-label="Primary" className="kct-scroll flex-1 overflow-y-auto px-2 py-3">
        <NavSection title="Main" isOpen={isExpanded}>
          {MAIN_NAV.map((entry) => (
            <NavItem key={entry.label} entry={entry} isOpen={isExpanded} />
          ))}
        </NavSection>
        <NavSection title="Account" isOpen={isExpanded}>
          {ACCOUNT_NAV.map((entry) => (
            <NavItem key={entry.label} entry={entry} isOpen={isExpanded} />
          ))}
        </NavSection>
        {isAdmin && (
          <NavSection title="Administration" isOpen={isExpanded}>
            {ADMIN_NAV.map((entry) => (
              <NavItem key={entry.label} entry={entry} isOpen={isExpanded} />
            ))}
          </NavSection>
        )}
      </nav>

      {/* User Footer */}
      <SidebarFooterInner isOpen={isExpanded} />
    </motion.aside>
  );
}

export function MobileSidebar({
  appName,
  logoUrl,
  open,
  onClose,
}: {
  appName: string;
  logoUrl?: string;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
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
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/75 backdrop-blur-sm lg:hidden"
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-surface shadow-2xl lg:hidden"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
              <span className="flex items-center gap-2.5" aria-hidden="true">
                <BrandMark logoUrl={logoUrl} label={`${appName} logo`} />
                <span className="text-sm font-semibold tracking-tight text-logo">{appName}</span>
              </span>
              <button
                type="button"
                ref={closeRef}
                onClick={onClose}
                aria-label="Close navigation"
                className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-primary transition-colors cursor-pointer"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <nav aria-label="Mobile Primary" className="kct-scroll flex-1 overflow-y-auto px-2 py-3">
              <NavSection title="Main" isOpen={true}>
                {MAIN_NAV.map((entry) => (
                  <NavItem key={entry.label} entry={entry} isOpen={true} onNavigate={onClose} />
                ))}
              </NavSection>
              <NavSection title="Account" isOpen={true}>
                {ACCOUNT_NAV.map((entry) => (
                  <NavItem key={entry.label} entry={entry} isOpen={true} onNavigate={onClose} />
                ))}
              </NavSection>
              {isAdmin && (
                <NavSection title="Administration" isOpen={true}>
                  {ADMIN_NAV.map((entry) => (
                    <NavItem key={entry.label} entry={entry} isOpen={true} onNavigate={onClose} />
                  ))}
                </NavSection>
              )}
            </nav>
            <SidebarFooterInner isOpen={true} onNavigate={onClose} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export function SidebarMenuButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open navigation"
      className="rounded-md p-2 text-muted hover:bg-raised hover:text-primary transition-colors lg:hidden cursor-pointer"
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
