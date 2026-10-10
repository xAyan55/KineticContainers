import * as React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAdmin, RequireAuth } from "@/features/auth/AuthContext";
import { AppShell } from "@/components/layout/AppShell";
import { LoginPage } from "@/pages/Login";
import { RegisterPage } from "@/pages/Register";
import { DashboardPage } from "@/pages/Dashboard";
import { InstanceDetailsPage } from "@/pages/InstanceDetails";
import { ProfilePage } from "@/pages/Profile";
import { AdminOverviewPage } from "@/pages/admin/Overview";
import { AdminNodesPage } from "@/pages/admin/Nodes";
import { AdminUsersPage } from "@/pages/admin/Users";
import { AdminUserDetailPage } from "@/pages/admin/UserDetail";
import { AdminCreatePage } from "@/pages/admin/Create";
import { AdminApiKeysPage } from "@/pages/admin/ApiKeys";
import { AdminSettingsPage } from "@/pages/admin/Settings";
import { NotFoundPage } from "@/pages/NotFound";
import { api } from "@/lib/api";
import { setFavicon, useBranding } from "@/lib/branding";

export function App(): React.JSX.Element {
  const [appName, setAppName] = React.useState("KineticCT");
  const { faviconUrl } = useBranding();

  React.useEffect(() => {
    api.get<{ settings: Record<string, string> }>("/api/settings/public")
      .then((d) => {
        if (d.settings.app_name) setAppName(d.settings.app_name);
        document.title = d.settings.page_title || d.settings.app_name || "KineticCT";
      })
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    setFavicon(faviconUrl || null);
  }, [faviconUrl]);

  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage appName={appName} />} />
          <Route path="/register" element={<RegisterPage appName={appName} />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <AppShell appName={appName}>
                  <DashboardPage />
                </AppShell>
              </RequireAuth>
            }
          />
          <Route
            path="/instances/:id/:tabId?"
            element={
              <RequireAuth>
                <AppShell appName={appName}>
                  <InstanceDetailsPage />
                </AppShell>
              </RequireAuth>
            }
          />
          <Route
            path="/profile"
            element={
              <RequireAuth>
                <AppShell appName={appName}>
                  <ProfilePage />
                </AppShell>
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AppShell appName={appName}>
                  <AdminOverviewPage />
                </AppShell>
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/nodes"
            element={
              <RequireAdmin>
                <AppShell appName={appName}>
                  <AdminNodesPage />
                </AppShell>
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/users"
            element={
              <RequireAdmin>
                <AppShell appName={appName}>
                  <AdminUsersPage />
                </AppShell>
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/users/:id"
            element={
              <RequireAdmin>
                <AppShell appName={appName}>
                  <AdminUserDetailPage />
                </AppShell>
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/create"
            element={
              <RequireAdmin>
                <AppShell appName={appName}>
                  <AdminCreatePage />
                </AppShell>
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/api-keys"
            element={
              <RequireAdmin>
                <AppShell appName={appName}>
                  <AdminApiKeysPage />
                </AppShell>
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/settings"
            element={
              <RequireAdmin>
                <AppShell appName={appName}>
                  <AdminSettingsPage />
                </AppShell>
              </RequireAdmin>
            }
          />
          <Route path="/404" element={<NotFoundPage />} />
          <Route path="*" element={<Navigate to="/404" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
