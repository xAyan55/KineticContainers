/**
 * Single source of truth for API key permissions.
 *
 * This registry drives, with no copies anywhere else:
 *  - server-side scope enforcement for `/api/v1` (`server/src/api/registry.ts`)
 *  - the administrator "Create API Key" UI (fetched from `/api/admin/api-keys/scopes`)
 *  - the OpenAPI document (`x-scope` on every protected operation)
 *  - tests that assert the three stay in sync
 */

export interface ScopeDefinition {
  id: string;
  label: string;
  group: string;
  description: string;
  /** Operations that change credentials, ownership, or infrastructure. */
  sensitive?: boolean;
}

/** Wildcard marker: grants every scope, present and future. */
export const FULL_ACCESS = "*";

export const SCOPE_DEFINITIONS: ScopeDefinition[] = [
  {
    id: "system:read",
    label: "Read panel information",
    group: "System",
    description: "Health, version, capabilities, the calling key's identity, dashboard overview, and long-running operation status.",
  },
  {
    id: "users:read",
    label: "Read users",
    group: "Users",
    description: "List and inspect user accounts and the instances they own.",
  },
  {
    id: "users:create",
    label: "Create users",
    group: "Users",
    description: "Create new panel accounts.",
    sensitive: true,
  },
  {
    id: "users:update",
    label: "Manage users",
    group: "Users",
    description: "Edit names, emails, roles, and status; reset passwords; transfer or assign instances; update the calling key owner's profile.",
    sensitive: true,
  },
  {
    id: "users:delete",
    label: "Delete users",
    group: "Users",
    description: "Delete accounts that no longer own instances.",
    sensitive: true,
  },
  {
    id: "instances:read",
    label: "Read VPS instances",
    group: "Instances",
    description: "List and inspect VPS records, live status, metrics, templates, and console availability.",
  },
  {
    id: "instances:create",
    label: "Create VPS instances",
    group: "Instances",
    description: "Provision new containers through the real virtualization provider.",
    sensitive: true,
  },
  {
    id: "instances:power",
    label: "Power VPS instances",
    group: "Instances",
    description: "Start, stop, and restart containers.",
    sensitive: true,
  },
  {
    id: "instances:delete",
    label: "Delete VPS instances",
    group: "Instances",
    description: "Destroy containers and remove their records.",
    sensitive: true,
  },
  {
    id: "instances:resources:read",
    label: "Read VPS resources",
    group: "Instances",
    description: "Read allocated and effectively enforced CPU, memory, and disk limits plus storage utilization.",
  },
  {
    id: "instances:resources:write",
    label: "Manage VPS resources",
    group: "Instances",
    description: "Change CPU, memory, and (where enforceable) disk limits, and run safe resource repairs.",
    sensitive: true,
  },
  {
    id: "instances:network:read",
    label: "Read VPS network",
    group: "Instances",
    description: "Read live container network configuration and addresses.",
  },
  {
    id: "instances:settings:write",
    label: "Manage VPS metadata",
    group: "Instances",
    description: "Rename instances and update instance metadata.",
    sensitive: true,
  },
  {
    id: "nodes:read",
    label: "Read nodes",
    group: "Nodes",
    description: "List and inspect registered nodes and the local node.",
  },
  {
    id: "nodes:create",
    label: "Register nodes",
    group: "Nodes",
    description: "Register supported node types.",
    sensitive: true,
  },
  {
    id: "nodes:update",
    label: "Manage nodes",
    group: "Nodes",
    description: "Edit supported node metadata such as the display name.",
    sensitive: true,
  },
  {
    id: "nodes:delete",
    label: "Remove nodes",
    group: "Nodes",
    description: "Remove eligible node registrations. Containers on the host are never destroyed by this operation.",
    sensitive: true,
  },
  {
    id: "nodes:health:check",
    label: "Check node health",
    group: "Nodes",
    description: "Run node health checks and connectivity tests.",
  },
  {
    id: "nodes:containers:read",
    label: "Read node containers",
    group: "Nodes",
    description: "List managed and unmanaged containers known to a node.",
  },
  {
    id: "settings:read",
    label: "Read settings",
    group: "Settings & audit",
    description: "Read administrator-visible application settings and runtime metadata.",
  },
  {
    id: "settings:write",
    label: "Manage settings",
    group: "Settings & audit",
    description: "Update application name, description, registration policy, session and password policy, timezone, and branding.",
    sensitive: true,
  },
  {
    id: "audit:read",
    label: "Read audit log",
    group: "Settings & audit",
    description: "Read sanitized audit events with filtering and pagination.",
  },
  {
    id: "api_keys:read",
    label: "Read API keys",
    group: "API keys",
    description: "Read API key metadata and usage. Secrets are never returned.",
  },
  {
    id: "api_keys:create",
    label: "Create API keys",
    group: "API keys",
    description: "Create subordinate API keys. A key can never mint a scope set wider than its own.",
    sensitive: true,
  },
  {
    id: "api_keys:update",
    label: "Manage API keys",
    group: "API keys",
    description: "Edit the name, scopes, expiration, and IP restrictions of subordinate keys.",
    sensitive: true,
  },
  {
    id: "api_keys:revoke",
    label: "Revoke API keys",
    group: "API keys",
    description: "Revoke or rotate subordinate keys. Revocation takes effect immediately.",
    sensitive: true,
  },
];

export const SCOPE_IDS: string[] = SCOPE_DEFINITIONS.map((s) => s.id);

export interface ScopeGroup {
  group: string;
  scopes: ScopeDefinition[];
}

export const SCOPE_GROUPS: ScopeGroup[] = SCOPE_DEFINITIONS.reduce<ScopeGroup[]>((acc, scope) => {
  const found = acc.find((g) => g.group === scope.group);
  if (found) found.scopes.push(scope);
  else acc.push({ group: scope.group, scopes: [scope] });
  return acc;
}, []);

export function isKnownScope(scope: string): boolean {
  return scope === FULL_ACCESS || SCOPE_IDS.includes(scope);
}

/**
 * Is `required` covered by `granted`? A `null` requirement (public route)
 * is always covered. The wildcard covers everything.
 */
export function hasScope(granted: readonly string[] | null | undefined, required: string | null): boolean {
  if (required === null) return true;
  if (!granted) return false;
  return granted.includes(FULL_ACCESS) || granted.includes(required);
}

/** True when every scope in `subset` is covered by `superset` (no escalation). */
export function isSubsetOf(subset: readonly string[], superset: readonly string[]): boolean {
  return subset.every((s) => hasScope(superset, s));
}

/** Public, non-secret description of the scope catalogue for the admin UI and docs. */
export function scopeCatalogue(): {
  scopes: ScopeDefinition[];
  groups: { group: string; scopes: string[] }[];
  full_access: string;
} {
  return {
    scopes: SCOPE_DEFINITIONS.map((s) => ({ ...s })),
    groups: SCOPE_GROUPS.map((g) => ({ group: g.group, scopes: g.scopes.map((s) => s.id) })),
    full_access: FULL_ACCESS,
  };
}
