import { Router } from "express";
import { getDb, nowIso } from "../../db.js";
import { getProvider, LocalLxcProvider } from "../../services/virtualization/localAgent.js";
import { requireAuth } from "../../middleware/auth.js";

/** Public application metadata for `/api/v1`. No environment, secrets, or host detail. */

export const v1MetaRouter = Router();

function appVersion(): string {
  return process.env.npm_package_version ?? "0.1.0";
}

v1MetaRouter.get("/health", (_req, res) => {
  res.json({
    data: {
      status: "ok",
      api_version: "v1",
      app_version: appVersion(),
      time: nowIso(),
    },
  });
});

v1MetaRouter.get("/version", (_req, res) => {
  const db = getDb();
  const migration = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  res.json({
    data: {
      api_version: "v1",
      app_version: appVersion(),
      schema_version: migration.v ?? 0,
      contract: { success: "{ data, meta }", error: "{ error: { code, message, request_id } }" },
      compatibility: "Additive changes may be made within v1; breaking changes will ship as /api/v2.",
    },
  });
});

v1MetaRouter.get("/capabilities", (_req, res) => {
  const provider = getProvider();
  res.json({
    data: {
      provider: provider.kind,
      provider_capabilities: provider.capabilities,
      templates: LocalLxcProvider.supportedTemplates(),
      features: {
        api_key_auth: true,
        scoped_permissions: true,
        rate_limiting: true,
        ip_restricted_keys: true,
        operation_log: true,
        async_provisioning: true,
        // Honest limitations of this build:
        remote_node_agents: false,
        interactive_console_over_api: false,
        arbitrary_host_commands_over_api: false,
      },
      notes: [
        "Remote node records are configuration only: no remote agent is implemented, so remote operations report REMOTE_NODE_UNSUPPORTED.",
        "Interactive consoles authenticate with a browser session cookie; /api/v1 exposes only the console preflight check.",
        "Disk quotas are enforced only where the host filesystem supports them (btrfs or ext4 project quotas).",
        "API keys never expose host shell access or stored application secrets.",
      ],
    },
  });
});

/** Identity of the issuing account plus the calling key's own permissions. */
export const v1MeRouter = Router();
v1MeRouter.use(requireAuth);
v1MeRouter.get("/", (req, res) => {
  const principal = req.apiPrincipal;
  res.json({
    data: {
      user: req.user,
      api_key: principal
        ? {
            id: principal.key.id,
            name: principal.key.name,
            key_prefix: principal.key.key_prefix,
            scopes: principal.scopes,
            full_access: principal.scopes.includes("*"),
            expires_at: principal.key.expires_at,
            ip_allowlist: principal.key.ip_allowlist ? (JSON.parse(principal.key.ip_allowlist) as string[]) : [],
            last_used_at: principal.key.last_used_at,
          }
        : null,
    },
  });
});
