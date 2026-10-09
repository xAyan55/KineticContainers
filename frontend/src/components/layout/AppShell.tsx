import * as React from "react";
import { Link } from "react-router-dom";
import { Server } from "lucide-react";
import { MobileSidebar, Sidebar, SidebarMenuButton } from "@/components/layout/Sidebar";

const COLLAPSE_KEY = "kineticct.sidebar.collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell({ appName, children }: { appName: string; children: React.ReactNode }): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState<boolean>(readCollapsed);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const toggleCollapse = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // Private-mode storage failures must not break navigation.
      }
      return next;
    });
  }, []);

  const closeDrawer = React.useCallback(() => setDrawerOpen(false), []);

  return (
    <div className="min-h-screen bg-base text-primary">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[60] focus:rounded focus:bg-raised focus:px-3 focus:py-2">
        Skip to content
      </a>
      <div className="flex min-h-screen">
        <Sidebar appName={appName} collapsed={collapsed} onToggleCollapse={toggleCollapse} />
        <MobileSidebar appName={appName} open={drawerOpen} onClose={closeDrawer} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-border bg-surface lg:hidden">
            <div className="flex h-14 items-center gap-2 px-3">
              <SidebarMenuButton onClick={() => setDrawerOpen(true)} />
              <Link to="/" className="flex min-w-0 items-center gap-2.5" aria-label={`${appName} home`}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-raised" aria-hidden="true">
                  <Server className="h-4 w-4 text-logo" />
                </span>
                <span className="truncate text-sm font-semibold tracking-tight text-logo">{appName}</span>
              </Link>
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
            {children}
          </main>
          <footer className="mx-auto w-full max-w-6xl px-4 pb-8 text-xs text-muted">
            <p>{appName} · self-hosted infrastructure panel</p>
          </footer>
        </div>
      </div>
    </div>
  );
}
