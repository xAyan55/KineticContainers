/**
 * The `/api/v1` route registry.
 *
 * Every route mounted under `/api/v1` MUST appear here with an explicit
 * scope (`null` = public). The scope guard fails closed: a request that
 * does not match a registry entry is rejected with 404 instead of falling
 * through to an unchecked handler. The OpenAPI document and the docs
 * coverage tests are generated from this list, so documentation cannot
 * drift from the routes that actually exist.
 */

import type { Request } from "express";

export interface RouteSpec {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Express path pattern, relative to `/api/v1`. */
  path: string;
  /** Required scope. `null` marks a public endpoint. */
  scope: string | null;
  /** Human summary used by the docs and the coverage tests. */
  summary: string;
  tag: string;
  operationId: string;
  /** Admin-role endpoints (the underlying handler also enforces this). */
  admin?: boolean;
  /** Endpoint that mutates credentials, ownership, or infrastructure. */
  sensitive?: boolean;
  /** Optional dynamic scope (e.g. power actions that can also destroy). */
  scopeResolver?: (req: Request) => string | null;
}

export const ROUTE_REGISTRY: RouteSpec[] = [
  // --- System -------------------------------------------------------------
  { method: "GET", path: "/health", scope: null, tag: "System", operationId: "getHealth", summary: "Liveness probe for the API process." },
  { method: "GET", path: "/version", scope: null, tag: "System", operationId: "getVersion", summary: "API version, schema version, and compatibility information." },
  { method: "GET", path: "/capabilities", scope: null, tag: "System", operationId: "getCapabilities", summary: "Feature and infrastructure capabilities of this installation." },
  { method: "GET", path: "/me", scope: "system:read", tag: "System", operationId: "getCurrentIdentity", summary: "Identity of the API key's issuing account and the key's own scopes." },
  { method: "PATCH", path: "/me", scope: "users:update", tag: "System", operationId: "updateCurrentIdentity", summary: "Update the issuing account's display name, email, or avatar seed.", sensitive: true },
  { method: "POST", path: "/me/password", scope: "users:update", tag: "System", operationId: "changeOwnPassword", summary: "Change the issuing account's password; every session is revoked.", sensitive: true },
  { method: "GET", path: "/overview", scope: "system:read", tag: "System", operationId: "getOverview", summary: "Dashboard counters, node summary, and recent audit events.", admin: true },

  // --- Authentication -----------------------------------------------------
  { method: "POST", path: "/auth/login", scope: null, tag: "Auth", operationId: "loginUser", summary: "Exchange credentials for a browser session cookie.", sensitive: true },
  { method: "POST", path: "/auth/logout", scope: null, tag: "Auth", operationId: "logoutUser", summary: "End the calling session. API keys are revoked separately." },
  { method: "GET", path: "/auth/session", scope: null, tag: "Auth", operationId: "getSession", summary: "Current session identity, or 401 when no session exists." },
  { method: "POST", path: "/auth/register", scope: null, tag: "Auth", operationId: "registerUser", summary: "Create an account through public registration when it is enabled.", sensitive: true },

  // --- Instances ----------------------------------------------------------
  { method: "GET", path: "/instances", scope: "instances:read", tag: "Instances", operationId: "listInstances", summary: "List VPS instances with filtering and pagination." },
  { method: "POST", path: "/instances", scope: "instances:create", tag: "Instances", operationId: "createInstance", summary: "Provision a VPS through the virtualization provider.", admin: true, sensitive: true },
  { method: "GET", path: "/instances/:id", scope: "instances:read", tag: "Instances", operationId: "getInstance", summary: "Instance record plus reconciled live state." },
  { method: "GET", path: "/instances/:id/live", scope: "instances:read", tag: "Instances", operationId: "getInstanceLive", summary: "Live status and CPU/memory metrics." },
  { method: "GET", path: "/instances/:id/network", scope: "instances:network:read", tag: "Instances", operationId: "getInstanceNetwork", summary: "Live network configuration from the host." },
  { method: "GET", path: "/instances/:id/config", scope: "instances:resources:read", tag: "Instances", operationId: "getInstanceConfig", summary: "Configured and effectively enforced resource limits." },
  { method: "PATCH", path: "/instances/:id/resources", scope: "instances:resources:write", tag: "Instances", operationId: "updateInstanceResources", summary: "Change CPU, memory, and enforceable disk limits.", admin: true, sensitive: true },
  { method: "PATCH", path: "/instances/:id", scope: "instances:settings:write", tag: "Instances", operationId: "renameInstance", summary: "Rename an instance.", admin: true, sensitive: true },
  { method: "DELETE", path: "/instances/:id", scope: "instances:delete", tag: "Instances", operationId: "deleteInstance", summary: "Destroy the container and remove its record.", admin: true, sensitive: true },
  { method: "GET", path: "/instances/:id/repair", scope: "instances:resources:read", tag: "Instances", operationId: "getInstanceRepairPlan", summary: "Read-only repair plan comparing the record with the host.", admin: true },
  { method: "POST", path: "/instances/:id/repair", scope: "instances:resources:write", tag: "Instances", operationId: "repairInstance", summary: "Apply a safe, non-destructive repair.", admin: true, sensitive: true },
  { method: "GET", path: "/instances/:id/console", scope: "instances:read", tag: "Instances", operationId: "getInstanceConsole", summary: "Console availability preflight. Interactive consoles require a browser session." },
  {
    method: "POST",
    path: "/instances/:id/actions",
    scope: "instances:power",
    tag: "Instances",
    operationId: "instanceAction",
    summary: "Start, stop, restart, or remove an instance.",
    sensitive: true,
    scopeResolver: (req) => ((req.body as { action?: string } | undefined)?.action === "remove" ? "instances:delete" : "instances:power"),
  },
  { method: "GET", path: "/templates", scope: "instances:read", tag: "Instances", operationId: "listTemplates", summary: "Operating-system templates supported by this host." },

  // --- Nodes --------------------------------------------------------------
  { method: "GET", path: "/nodes", scope: "nodes:read", tag: "Nodes", operationId: "listNodes", summary: "Registered nodes and the active provider kind.", admin: true },
  { method: "POST", path: "/nodes", scope: "nodes:create", tag: "Nodes", operationId: "createNode", summary: "Register a supported node type.", admin: true, sensitive: true },
  { method: "GET", path: "/nodes/:id", scope: "nodes:read", tag: "Nodes", operationId: "getNode", summary: "Node record including managed container count.", admin: true },
  { method: "PATCH", path: "/nodes/:id", scope: "nodes:update", tag: "Nodes", operationId: "updateNode", summary: "Edit the node display name.", admin: true, sensitive: true },
  { method: "DELETE", path: "/nodes/:id", scope: "nodes:delete", tag: "Nodes", operationId: "deleteNode", summary: "Remove an eligible node registration. Containers are never destroyed.", admin: true, sensitive: true },
  { method: "POST", path: "/nodes/:id/check", scope: "nodes:health:check", tag: "Nodes", operationId: "checkNodeHealth", summary: "Run and persist a real health check.", admin: true },
  { method: "POST", path: "/nodes/:id/test", scope: "nodes:health:check", tag: "Nodes", operationId: "testNodeConnectivity", summary: "Connectivity test against the node.", admin: true },
  { method: "GET", path: "/nodes/:id/containers", scope: "nodes:containers:read", tag: "Nodes", operationId: "listNodeContainers", summary: "Managed and unmanaged containers known to the node.", admin: true },

  // --- Users --------------------------------------------------------------
  { method: "GET", path: "/users", scope: "users:read", tag: "Users", operationId: "listUsers", summary: "Search and paginate user accounts.", admin: true },
  { method: "POST", path: "/users", scope: "users:create", tag: "Users", operationId: "createUser", summary: "Create a user account directly.", admin: true, sensitive: true },
  { method: "GET", path: "/users/:id", scope: "users:read", tag: "Users", operationId: "getUser", summary: "User account and the instances it owns.", admin: true },
  { method: "PATCH", path: "/users/:id", scope: "users:update", tag: "Users", operationId: "updateUser", summary: "Update name, email, role, or account status.", admin: true, sensitive: true },
  { method: "DELETE", path: "/users/:id", scope: "users:delete", tag: "Users", operationId: "deleteUser", summary: "Delete an account that owns no instances.", admin: true, sensitive: true },
  { method: "POST", path: "/users/:id/reset-password", scope: "users:update", tag: "Users", operationId: "resetUserPassword", summary: "Set a new password and revoke the user's sessions.", admin: true, sensitive: true },
  { method: "POST", path: "/users/:id/transfer-instances", scope: "users:update", tag: "Users", operationId: "transferUserInstances", summary: "Transfer every instance owned by the user.", admin: true, sensitive: true },
  { method: "POST", path: "/users/:id/assign-instance", scope: "users:update", tag: "Users", operationId: "assignInstanceToUser", summary: "Assign an instance to the user.", admin: true, sensitive: true },

  // --- Settings -----------------------------------------------------------
  { method: "GET", path: "/settings/public", scope: null, tag: "Settings", operationId: "getPublicSettings", summary: "Public branding and registration settings." },
  { method: "GET", path: "/settings/branding/:kind", scope: null, tag: "Settings", operationId: "getBrandingAsset", summary: "Logo or favicon image bytes." },
  { method: "GET", path: "/settings", scope: "settings:read", tag: "Settings", operationId: "getSettings", summary: "Administrator settings plus runtime metadata.", admin: true },
  { method: "PATCH", path: "/settings", scope: "settings:write", tag: "Settings", operationId: "updateSettings", summary: "Update application, policy, and timezone settings.", admin: true, sensitive: true },
  { method: "POST", path: "/settings/branding", scope: "settings:write", tag: "Settings", operationId: "updateBranding", summary: "Upload or clear the logo and favicon.", admin: true, sensitive: true },

  // --- Audit --------------------------------------------------------------
  { method: "GET", path: "/audit/events", scope: "audit:read", tag: "Audit", operationId: "listAuditEvents", summary: "Sanitized audit events with filters and pagination.", admin: true },

  // --- Operations ---------------------------------------------------------
  { method: "GET", path: "/operations", scope: "system:read", tag: "Operations", operationId: "listOperations", summary: "Long-running operation records with pagination." },
  { method: "GET", path: "/operations/:id", scope: "system:read", tag: "Operations", operationId: "getOperation", summary: "Status and result of a single operation." },

  // --- API keys -----------------------------------------------------------
  { method: "GET", path: "/api-keys", scope: "api_keys:read", tag: "API keys", operationId: "listApiKeys", summary: "List API keys created by the calling key. Secrets are never returned.", admin: true },
  { method: "POST", path: "/api-keys", scope: "api_keys:create", tag: "API keys", operationId: "createApiKey", summary: "Create a subordinate API key. The secret is returned once.", admin: true, sensitive: true },
  { method: "GET", path: "/api-keys/scopes", scope: "api_keys:read", tag: "API keys", operationId: "listScopes", summary: "Scope catalogue shared by clients, the console, and enforcement.", admin: true },
  { method: "GET", path: "/api-keys/:id", scope: "api_keys:read", tag: "API keys", operationId: "getApiKey", summary: "Metadata, scopes, and usage for a subordinate key.", admin: true },
  { method: "PATCH", path: "/api-keys/:id", scope: "api_keys:update", tag: "API keys", operationId: "updateApiKey", summary: "Edit name, scopes, expiration, or IP restrictions.", admin: true, sensitive: true },
  { method: "POST", path: "/api-keys/:id/rotate", scope: "api_keys:revoke", tag: "API keys", operationId: "rotateApiKey", summary: "Create a replacement secret, optionally revoking the original.", admin: true, sensitive: true },
  { method: "DELETE", path: "/api-keys/:id", scope: "api_keys:revoke", tag: "API keys", operationId: "revokeApiKey", summary: "Revoke a subordinate key immediately.", admin: true, sensitive: true },
];

export function normalizeRoutePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

interface CompiledRoute extends RouteSpec {
  regex: RegExp;
  keys: string[];
}

function compile(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      if (segment === "") return "";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}/?$`), keys };
}

const COMPILED: CompiledRoute[] = ROUTE_REGISTRY.map((spec) => ({ ...spec, ...compile(spec.path) }));

export interface RouteMatch {
  spec: RouteSpec;
  params: Record<string, string>;
}

export function matchRoute(method: string, path: string): RouteMatch | null {
  const normalized = normalizeRoutePath(path) || "/";
  const upper = method.toUpperCase();
  for (const route of COMPILED) {
    if (route.method !== upper) continue;
    const m = route.regex.exec(normalized);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1]);
    });
    return { spec: route, params };
  }
  return null;
}

/** Required scope for a request, honouring dynamic resolvers. */
export function requiredScope(spec: RouteSpec, req: Request): string | null {
  if (spec.scopeResolver) return spec.scopeResolver(req);
  return spec.scope;
}
