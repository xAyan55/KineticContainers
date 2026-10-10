import { ROUTE_REGISTRY, type RouteSpec } from "./registry.js";
import { SCOPE_DEFINITIONS } from "./scopes.js";

/**
 * OpenAPI 3.1 document for `/api/v1`.
 *
 * Paths are generated from the route registry (the same list the scope guard
 * enforces), so the specification cannot describe an endpoint that does not
 * exist or omit one that does. Per-endpoint detail lives in `DOCS`; anything
 * not specified there falls back to a conservative default built from the
 * registry entry.
 *
 * The document is written to `docs/openapi.json` (`npm run openapi`) and a
 * test asserts the committed file matches this builder exactly.
 */

type SchemaObject = Record<string, unknown>;

const APP_VERSION = process.env.npm_package_version ?? "0.1.0";

const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });

function envelope(data: SchemaObject): SchemaObject {
  return {
    type: "object",
    required: ["data", "meta"],
    properties: { data, meta: ref("Meta") },
  };
}

function errorBody(description: string): SchemaObject {
  return {
    type: "object",
    description,
    required: ["error"],
    properties: { error: ref("ErrorObject") },
  };
}

function errorResponse(status: number, description: string): [string, SchemaObject] {
  return [
    String(status),
    { description, content: { "application/json": { schema: errorBody(description) } } },
  ];
}

interface QueryParam {
  name: string;
  description: string;
  schema: SchemaObject;
  example?: unknown;
}

interface DocEntry {
  description: string;
  query?: QueryParam[];
  requestBody?: { required?: boolean; schema: SchemaObject; example?: unknown };
  successStatus?: number;
  successSchema: SchemaObject;
  successDescription?: string;
  /** Extra non-error responses (e.g. 202 for async work). */
  extraResponses?: { status: number; description: string; schema: SchemaObject }[];
  /** Additional error statuses beyond the standard set. */
  errors?: (number | { status: number; description: string })[];
  /** Skip the standard auth error set (public endpoints). */
  public?: boolean;
}

const PAGE_QUERY: QueryParam[] = [
  { name: "page", description: "Page number (1-based).", schema: { type: "integer", minimum: 1, default: 1 } },
  { name: "page_size", description: "Items per page (1–100).", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
];

const PARAM_DESCRIPTIONS: Record<string, string> = {
  id: "Identifier of the resource.",
  kind: "Branding asset kind.",
};

function pathParameters(spec: RouteSpec): SchemaObject[] {
  return spec.path
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => {
      const name = segment.slice(1);
      return {
        name,
        in: "path",
        required: true,
        description: PARAM_DESCRIPTIONS[name] ?? `${name} identifier.`,
        schema: { type: "string" },
      };
    });
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const SCHEMAS: Record<string, SchemaObject> = {
  Meta: {
    type: "object",
    required: ["request_id"],
    description: "Response metadata. Every `/api/v1` JSON response carries the id that produced it.",
    properties: { request_id: { type: "string", example: "req_Ab12cD34eF56gH78" } },
  },
  ErrorObject: {
    type: "object",
    required: ["code", "message"],
    description: "Machine-readable code, human message, and the request id. `details` is present on validation and scope errors.",
    properties: {
      code: {
        type: "string",
        example: "INSUFFICIENT_SCOPE",
        description: "Stable error code (see docs/API.md for the full list).",
      },
      message: { type: "string", example: "This API key does not have permission to perform this operation." },
      request_id: { type: "string", example: "req_Ab12cD34eF56gH78" },
      details: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, message: { type: "string" } },
        },
      },
    },
  },
  Pagination: {
    type: "object",
    required: ["page", "page_size", "total"],
    properties: {
      page: { type: "integer", example: 1 },
      page_size: { type: "integer", example: 25 },
      total: { type: "integer", example: 42 },
    },
  },
  Health: {
    type: "object",
    properties: {
      status: { type: "string", example: "ok" },
      api_version: { type: "string", example: "v1" },
      app_version: { type: "string", example: APP_VERSION },
      time: { type: "string", format: "date-time" },
    },
  },
  Version: {
    type: "object",
    properties: {
      api_version: { type: "string", example: "v1" },
      app_version: { type: "string", example: APP_VERSION },
      schema_version: { type: "integer", example: 3 },
      contract: { type: "object", additionalProperties: { type: "string" } },
      compatibility: { type: "string" },
    },
  },
  Capabilities: {
    type: "object",
    description: "What this installation can actually do. Limitations are stated explicitly instead of failing later.",
    properties: {
      provider: { type: "string", example: "local-lxc" },
      provider_capabilities: {
        type: "object",
        properties: {
          create: { type: "boolean" },
          start: { type: "boolean" },
          stop: { type: "boolean" },
          remove: { type: "boolean" },
          liveStatus: { type: "boolean" },
        },
      },
      templates: { type: "array", items: { type: "string" }, example: ["ubuntu-22.04"] },
      features: { type: "object", additionalProperties: { type: "boolean" } },
      notes: { type: "array", items: { type: "string" } },
    },
  },
  User: {
    type: "object",
    description: "Public user fields. Password hashes and session tokens are never returned.",
    required: ["id", "email", "name", "role", "status"],
    properties: {
      id: { type: "string", example: "usr_1a2b3c4d5e6f7890" },
      email: { type: "string", format: "email", example: "admin@example.com" },
      name: { type: "string", example: "Administrator" },
      role: { type: "string", enum: ["admin", "user"] },
      status: { type: "string", enum: ["active", "disabled"] },
      avatar_seed: { type: "string" },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      instance_count: { type: "integer", description: "Present in list responses." },
    },
  },
  Instance: {
    type: "object",
    required: ["id", "name", "container_id", "status"],
    properties: {
      id: { type: "string", example: "vps_9f8e7d6c5b4a3928" },
      name: { type: "string", example: "web-01" },
      container_id: { type: "string", example: "web-01" },
      node_id: { type: "string", nullable: true },
      node_name: { type: "string", nullable: true },
      status: { type: "string", enum: ["running", "stopped", "starting", "stopping", "failed", "unknown"] },
      cpu: { type: "integer" },
      memory_mb: { type: "integer" },
      storage_gb: { type: "integer" },
      template: { type: "string", nullable: true },
      ip_address: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  LiveState: {
    type: "object",
    description: "Reconciled host state. `exists: null` means the host could not be checked — never guessed.",
    properties: {
      exists: { oneOf: [{ type: "boolean" }, { type: "null" }] },
      status: { type: "string", nullable: true },
      checkedAt: { type: "string", format: "date-time" },
      error: { type: "string", nullable: true },
    },
  },
  Metrics: {
    type: "object",
    nullable: true,
    properties: {
      cpuPercent: { type: "number", nullable: true },
      memoryMb: { type: "number", nullable: true },
      memoryLimitMb: { type: "number", nullable: true },
      cpuSeconds: { type: "number", nullable: true },
      checkedAt: { type: "string", format: "date-time" },
    },
  },
  EffectiveConfig: {
    type: "object",
    description: "Limits as the host actually applies them, plus storage and lxcfs facts.",
    properties: {
      configured: {
        type: "object",
        properties: { cpu: { type: "integer" }, memory_mb: { type: "integer" }, storage_gb: { type: "integer" } },
      },
      effective: { type: "object", additionalProperties: true },
      storage: { type: "object", nullable: true, additionalProperties: true },
      lxcfs: { type: "object", nullable: true, properties: { active: { type: "boolean", nullable: true } } },
    },
  },
  Network: {
    type: "object",
    additionalProperties: true,
    description: "Live network facts read from the host (interfaces, addresses, gateway).",
  },
  Node: {
    type: "object",
    required: ["id", "name", "endpoint"],
    description: "Node record. `api_token` is stored server-side and never returned.",
    properties: {
      id: { type: "string", example: "local" },
      name: { type: "string", example: "Local Node" },
      endpoint: { type: "string", example: "local" },
      node_type: { type: "string", enum: ["local", "remote"] },
      provider: { type: "string", example: "local-lxc" },
      host_address: { type: "string", nullable: true },
      status: { type: "string" },
      last_seen_at: { type: "string", format: "date-time", nullable: true },
      last_check_at: { type: "string", format: "date-time", nullable: true },
      last_check_ok: { type: "boolean", nullable: true },
      last_error: { type: "string", nullable: true },
      is_protected: { type: "boolean" },
      capabilities: { type: "string", nullable: true },
      managed_containers: { type: "integer" },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  NodeHealth: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["online", "unconfigured", "error", "unavailable"] },
      ok: { type: "boolean" },
      checkedAt: { type: "string", format: "date-time" },
      detail: { type: "string" },
      host: { type: "object", nullable: true, additionalProperties: true },
      containersTotal: { type: "integer", nullable: true },
      containersRunning: { type: "integer", nullable: true },
    },
  },
  NodeContainer: {
    type: "object",
    properties: {
      containerId: { type: "string" },
      name: { type: "string" },
      status: { type: "string" },
      ipv4: { type: "string", nullable: true },
      managed: { type: "boolean", description: "False for host containers KineticCT does not track." },
      owner: { type: "object", nullable: true, additionalProperties: true },
    },
  },
  ApiKey: {
    type: "object",
    description: "API key metadata. The plaintext secret exists only in the create/rotate response and is never stored or returned again.",
    required: ["id", "name", "key_prefix", "scopes", "status"],
    properties: {
      id: { type: "string", example: "key_5b6a7c8d9e0f1234" },
      name: { type: "string", example: "Automation Service" },
      key_prefix: { type: "string", example: "kct_live_a1b2c3d4e5f6", description: "Public identifier; safe to display." },
      created_by: { type: "string", nullable: true },
      created_by_name: { type: "string", nullable: true },
      created_by_key: { type: "string", nullable: true, description: "Parent key id when created through the API." },
      scopes: { type: "array", items: { type: "string" }, example: ["instances:read", "instances:power"] },
      full_access: { type: "boolean" },
      ip_allowlist: { type: "array", items: { type: "string" }, example: ["203.0.113.0/24"] },
      expires_at: { type: "string", format: "date-time", nullable: true },
      last_used_at: { type: "string", format: "date-time", nullable: true },
      last_used_endpoint: { type: "string", nullable: true, example: "GET /api/v1/instances" },
      use_count: { type: "integer" },
      rotated_from: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      revoked_at: { type: "string", format: "date-time", nullable: true },
      status: { type: "string", enum: ["active", "expired", "revoked"] },
    },
  },
  ApiKeyCreated: {
    type: "object",
    required: ["key", "secret"],
    properties: {
      key: ref("ApiKey"),
      secret: {
        type: "string",
        description: "The full plaintext key. Shown once — copy it now; it cannot be retrieved later.",
        example: "kct_live_a1b2c3d4e5f6_Zm9vYmFyYmF6cXV4.example-secret-never-stored",
      },
    },
  },
  Operation: {
    type: "object",
    description: "A recorded infrastructure operation with honest state transitions.",
    required: ["id", "type", "state"],
    properties: {
      id: { type: "string", example: "op_1f2e3d4c5b6a7980" },
      type: {
        type: "string",
        example: "instance.create",
        description: "instance.create | instance.delete | instance.action | instance.repair | instance.resources_update | node.create | node.delete",
      },
      state: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
      instance_id: { type: "string", nullable: true },
      node_id: { type: "string", nullable: true },
      actor_id: { type: "string", nullable: true },
      actor_key_id: { type: "string", nullable: true },
      detail: { type: "object", nullable: true, additionalProperties: true },
      error: { type: "string", nullable: true },
      progress: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
      started_at: { type: "string", format: "date-time", nullable: true },
      finished_at: { type: "string", format: "date-time", nullable: true },
      duration_ms: { type: "integer", nullable: true },
    },
  },
  AuditEvent: {
    type: "object",
    properties: {
      id: { type: "string" },
      actor_id: { type: "string", nullable: true },
      actor_email: { type: "string", nullable: true },
      actor_name: { type: "string", nullable: true },
      action: { type: "string", example: "instance.create" },
      target_type: { type: "string", nullable: true },
      target_id: { type: "string", nullable: true },
      detail: { type: "object", nullable: true, additionalProperties: true, description: "Redacted: credential-like keys are replaced with [redacted]." },
      created_at: { type: "string", format: "date-time" },
    },
  },
  Settings: {
    type: "object",
    properties: {
      settings: { type: "object", additionalProperties: { type: "string" } },
      meta: { type: "object", additionalProperties: true },
    },
  },
  Overview: {
    type: "object",
    properties: {
      users_total: { type: "integer" },
      containers_total: { type: "integer" },
      containers_running: { type: "integer" },
      containers_stopped: { type: "integer" },
      nodes_total: { type: "integer" },
      nodes: { type: "array", items: ref("Node") },
      utilization: { type: "object", nullable: true, additionalProperties: true },
      infra_status: { type: "string" },
      infra_configured: { type: "boolean" },
      recent_events: { type: "array", items: ref("AuditEvent") },
      migration_version: { type: "integer" },
      app_version: { type: "string" },
    },
  },
  Identity: {
    type: "object",
    properties: {
      user: ref("User"),
      api_key: {
        type: "object",
        nullable: true,
        description: "Present for Bearer-authenticated calls: the calling key's own identity and scopes.",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          key_prefix: { type: "string" },
          scopes: { type: "array", items: { type: "string" } },
          full_access: { type: "boolean" },
          expires_at: { type: "string", format: "date-time", nullable: true },
          ip_allowlist: { type: "array", items: { type: "string" } },
          last_used_at: { type: "string", format: "date-time", nullable: true },
        },
      },
    },
  },
  ScopeCatalogue: {
    type: "object",
    description: "The authoritative scope list used by enforcement, the admin UI, and this document.",
    properties: {
      scopes: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label", "group", "description"],
          properties: {
            id: { type: "string", example: "instances:read" },
            label: { type: "string" },
            group: { type: "string" },
            description: { type: "string" },
            sensitive: { type: "boolean" },
          },
        },
      },
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: { group: { type: "string" }, scopes: { type: "array", items: { type: "string" } } },
        },
      },
      full_access: { type: "string", example: "*", description: "Wildcard scope that grants everything." },
    },
  },
  InstanceList: {
    type: "object",
    properties: { instances: { type: "array", items: ref("Instance") }, pagination: ref("Pagination") },
  },
  UserList: {
    type: "object",
    properties: { users: { type: "array", items: ref("User") }, pagination: ref("Pagination") },
  },
  NodeList: {
    type: "object",
    properties: { nodes: { type: "array", items: ref("Node") }, provider: { type: "string" } },
  },
  ApiKeyList: {
    type: "object",
    properties: { keys: { type: "array", items: ref("ApiKey") }, pagination: ref("Pagination") },
  },
  OperationList: {
    type: "object",
    properties: { operations: { type: "array", items: ref("Operation") }, pagination: ref("Pagination") },
  },
  AuditList: {
    type: "object",
    properties: { events: { type: "array", items: ref("AuditEvent") }, pagination: ref("Pagination") },
  },
};

/* ------------------------------------------------------------------ *
 * Per-endpoint documentation
 * ------------------------------------------------------------------ */

const DOCS: Record<string, DocEntry> = {
  getHealth: {
    description: "Liveness probe. Returns process-level status only — no environment variables, host details, or stack traces.",
    successSchema: envelope(ref("Health")),
    public: true,
  },
  getVersion: {
    description: "API version, database schema version, response contract, and the compatibility policy for this major version.",
    successSchema: envelope(ref("Version")),
    public: true,
  },
  getCapabilities: {
    description: "Provider capabilities and an explicit list of what this build does not support (remote node agents, interactive consoles over the API, arbitrary host commands).",
    successSchema: envelope(ref("Capabilities")),
    public: true,
  },
  getCurrentIdentity: {
    description: "The issuing account plus the calling key's own scopes, expiry, and IP restrictions — useful for discovering what a key may do.",
    successSchema: envelope(ref("Identity")),
  },
  updateCurrentIdentity: {
    description: "Update the issuing account's display name, email, or avatar seed. Passwords are changed through `POST /me/password`.",
    requestBody: {
      schema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          email: { type: "string", format: "email" },
          avatar_seed: { type: "string", maxLength: 120 },
        },
      },
      example: { name: "Automation Owner" },
    },
    successSchema: envelope({ type: "object", properties: { user: ref("User") } }),
    errors: [409],
  },
  changeOwnPassword: {
    description:
      "Change the issuing account's password after proving knowledge of the current one. Every other session of that account is revoked; API keys are unaffected.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["current_password", "new_password"],
        properties: {
          current_password: { type: "string", minLength: 1, maxLength: 256 },
          new_password: { type: "string", minLength: 8, maxLength: 256 },
        },
      },
      example: { current_password: "current-password", new_password: "a-new-strong-password" },
    },
    successSchema: envelope({ type: "object", properties: { ok: { type: "boolean" } } }),
    errors: [{ status: 401, description: "The current password is incorrect." }, 400],
  },
  getOverview: {
    description: "Dashboard counters, node summary, live utilization (or an honest error when unavailable), and recent audit events.",
    successSchema: envelope(ref("Overview")),
  },
  registerUser: {
    description: "Public registration. Returns 403 when registration is disabled server-side; the first account ever created becomes an administrator.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["email", "password", "name"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8, maxLength: 256 },
          name: { type: "string", minLength: 1, maxLength: 120 },
        },
      },
      example: { email: "new@example.com", password: "a-strong-password", name: "New User" },
    },
    successStatus: 201,
    successSchema: envelope({ type: "object", properties: { user: ref("User") } }),
    errors: [403, 409],
    public: true,
  },
  loginUser: {
    description:
      "Exchange an email and password for an HttpOnly session cookie. Provided for browser clients and completeness — API integrations authenticate with a Bearer key instead. The response never reveals whether an account exists, and repeated failures are throttled per IP.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      example: { email: "admin@example.com", password: "a-strong-password" },
    },
    successSchema: envelope({ type: "object", properties: { user: ref("User") } }),
    errors: [{ status: 401, description: "Invalid credentials, or the account is not active." }],
    public: true,
  },
  logoutUser: {
    description:
      "End the current session and clear its cookie. With an API key there is no session to end — revoke the key with `DELETE /api/v1/api-keys/{id}` instead.",
    successSchema: envelope({ type: "object", properties: { ok: { type: "boolean" } } }),
  },
  getSession: {
    description: "The identity behind the caller's session (or issuing account when called with an API key).",
    successSchema: envelope({ type: "object", properties: { user: ref("User") } }),
  },
  listInstances: {
    description: "List instances. Administrators see every instance and may filter by `owner_id`; ordinary accounts are always restricted to their own records.",
    query: [
      ...PAGE_QUERY,
      { name: "status", description: "Filter by recorded status.", schema: { type: "string" }, example: "running" },
      { name: "owner_id", description: "Administrator only: restrict to one owner.", schema: { type: "string" } },
      { name: "node_id", description: "Filter by node.", schema: { type: "string" } },
      { name: "template", description: "Filter by template.", schema: { type: "string" } },
      { name: "q", description: "Substring match on name or container id.", schema: { type: "string" } },
    ],
    successSchema: envelope(ref("InstanceList")),
  },
  createInstance: {
    description:
      "Provision a container through the virtualization provider. Synchronous (201) by default; `async: true` returns 202 with an operation to poll. Host capacity, template support, and identifier collisions are verified against the real host before anything is recorded.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["name", "node_id", "owner_id", "template", "cpu", "memory_mb", "storage_gb"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 63, pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" },
          node_id: { type: "string", example: "local" },
          owner_id: { type: "string" },
          template: { type: "string", example: "ubuntu-22.04" },
          cpu: { type: "integer", minimum: 1, maximum: 32 },
          memory_mb: { type: "integer", minimum: 128, maximum: 131072 },
          storage_gb: { type: "integer", minimum: 1, maximum: 2000 },
          container_id: { type: "string", description: "Optional; defaults to `name`." },
          async: { type: "boolean", default: false, description: "Return 202 with an operation instead of waiting." },
        },
      },
      example: { name: "web-01", node_id: "local", owner_id: "usr_1a2b3c4d5e6f7890", template: "ubuntu-22.04", cpu: 2, memory_mb: 2048, storage_gb: 20 },
    },
    successStatus: 201,
    successSchema: envelope({
      type: "object",
      properties: { instance: ref("Instance"), operation: ref("Operation") },
    }),
    extraResponses: [
      { status: 202, description: "Accepted: provisioning runs in the background; poll the returned operation.", schema: envelope({ type: "object", properties: { operation: ref("Operation") } }) },
    ],
    errors: [400, 404, 409, 502],
  },
  getInstance: {
    description: "Instance record plus live host state, reconciled at read time so a stale database row is never presented as truth.",
    successSchema: envelope({ type: "object", properties: { instance: ref("Instance"), live: ref("LiveState") } }),
    errors: [404],
  },
  getInstanceLive: {
    description: "Live status and real CPU/memory metrics. Metrics are `null` when the container is stopped or unreadable — never fabricated.",
    successSchema: envelope({ type: "object", properties: { live: ref("LiveState"), metrics: ref("Metrics") } }),
    errors: [404],
  },
  getInstanceNetwork: {
    description: "Network configuration read from the host for this container.",
    successSchema: envelope({ type: "object", properties: { network: ref("Network"), checkedAt: { type: "string", format: "date-time" } } }),
    errors: [404, 409, 502],
  },
  getInstanceConfig: {
    description: "Configured allocation, the limits actually enforced on the host, storage utilization, and whether lxcfs is serving this container.",
    successSchema: envelope(ref("EffectiveConfig")),
    errors: [404, 409, 502],
  },
  updateInstanceResources: {
    description:
      "Change CPU and memory (applied through cgroups) and disk where a quota can actually be enforced. Returns `400 STORAGE_IMMUTABLE` when the host filesystem cannot enforce the requested disk limit, instead of recording a value the host does not honour.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        properties: {
          cpu: { type: "integer", minimum: 1, maximum: 32 },
          memory_mb: { type: "integer", minimum: 128, maximum: 131072 },
          storage_gb: { type: "integer", minimum: 1, maximum: 2000 },
        },
      },
      example: { cpu: 2, memory_mb: 2048 },
    },
    successSchema: envelope({
      type: "object",
      properties: {
        instance: ref("Instance"),
        liveApplied: { type: "boolean" },
        restartRequired: { type: "boolean" },
        cgroupVersion: { type: "string" },
        effective: { type: "object", nullable: true, additionalProperties: true },
      },
    }),
    errors: [400, 403, 404, 409, 502],
  },
  renameInstance: {
    description: "Rename the display name. The container identifier on the host is immutable. Administrator-only.",
    requestBody: {
      required: true,
      schema: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 2, maxLength: 63 } } },
      example: { name: "web-02" },
    },
    successSchema: envelope({ type: "object", properties: { instance: ref("Instance") } }),
    errors: [400, 403, 404],
  },
  deleteInstance: {
    description: "Destroy the exact host container, confirm it is gone, then delete the record. Administrator-only; a partial failure is reported, never hidden.",
    successSchema: envelope({ type: "object", properties: { removed: { type: "boolean" }, removedHostContainer: { type: "boolean" } } }),
    errors: [403, 404, 409, 502],
  },
  getInstanceRepairPlan: {
    description: "Read-only comparison of the stored allocation with the effective host configuration. Nothing is modified.",
    successSchema: envelope({ type: "object", properties: { plan: { type: "object", additionalProperties: true } } }),
    errors: [403, 404, 409, 502],
  },
  repairInstance: {
    description: "Apply the safe repair set: re-apply drifted CPU/memory limits, add the lxcfs include, enforce btrfs quotas. Never destroys, recreates, or migrates storage.",
    successSchema: envelope({ type: "object", properties: { report: { type: "object", additionalProperties: true } } }),
    errors: [403, 404, 409, 502],
  },
  getInstanceConsole: {
    description: "Console preflight: whether an interactive console could be opened right now. No session is started. Interactive consoles themselves authenticate with a browser session cookie and are not available over the API.",
    successSchema: envelope({ type: "object", additionalProperties: true }),
    errors: [404, 409, 502],
  },
  instanceAction: {
    description: "Start, stop, or restart a container (scope `instances:power`), or remove it (scope `instances:delete`). Every action is confirmed against real host state before the database is updated.",
    requestBody: {
      required: true,
      schema: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["start", "stop", "restart", "remove"] } } },
      example: { action: "start" },
    },
    successSchema: envelope({
      type: "object",
      properties: { instance: ref("Instance"), live: ref("LiveState"), removed: { type: "boolean" } },
    }),
    errors: [400, 403, 404, 409, 502],
  },
  listTemplates: {
    description: "Operating-system templates the local provider can provision.",
    successSchema: envelope({ type: "object", properties: { templates: { type: "array", items: { type: "string" } } } }),
  },
  listNodes: {
    description: "Registered nodes plus the active provider kind. Stored tokens are never included.",
    successSchema: envelope(ref("NodeList")),
  },
  createNode: {
    description: "Register a node. `connection: remote` stores configuration only and reports `unconfigured`: no remote agent exists in this build, so connectivity is never faked.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          connection: { type: "string", enum: ["local", "remote"], default: "remote" },
          host_address: { type: "string", description: "Required for remote nodes." },
          api_token: { type: "string", description: "Stored server-side; never returned." },
        },
      },
      example: { name: "edge-01", connection: "remote", host_address: "192.0.2.10" },
    },
    successStatus: 201,
    successSchema: envelope({ type: "object", properties: { node: ref("Node") } }),
    errors: [400, 409],
  },
  getNode: {
    description: "Node record with the number of instances it hosts.",
    successSchema: envelope({ type: "object", properties: { node: ref("Node") } }),
    errors: [404],
  },
  updateNode: {
    description: "Edit the display name. Identity fields (id, endpoint, node type, provider) are immutable.",
    requestBody: {
      required: true,
      schema: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 120 } } },
      example: { name: "Primary Host" },
    },
    successSchema: envelope({ type: "object", properties: { node: ref("Node") } }),
    errors: [400, 404],
  },
  deleteNode: {
    description: "Remove a node registration. The Local Node is protected, nodes still hosting instance records are rejected (409), and containers on the host are never destroyed.",
    successSchema: envelope({ type: "object", properties: { ok: { type: "boolean" } } }),
    errors: [403, 404, 409],
  },
  checkNodeHealth: {
    description: "Run a real health check and persist the outcome. A completed check that reports problems is still 200; remote nodes answer 409 because no remote agent exists.",
    successSchema: envelope({ type: "object", properties: { check: ref("NodeHealth") } }),
    errors: [404, 409, 502],
  },
  testNodeConnectivity: {
    description: "One-shot connectivity test. `502 NODE_UNREACHABLE` when the host cannot be reached.",
    successSchema: envelope({ type: "object", properties: { status: { type: "object", additionalProperties: true } } }),
    errors: [404, 502],
  },
  listNodeContainers: {
    description: "Live container inventory with KineticCT ownership resolved. Host-only containers appear as `managed: false`.",
    successSchema: envelope({
      type: "object",
      properties: {
        nodeId: { type: "string" },
        checkedAt: { type: "string", format: "date-time" },
        containers: { type: "array", items: ref("NodeContainer") },
      },
    }),
    errors: [409, 502],
  },
  listUsers: {
    description: "Search and paginate user accounts.",
    query: [
      ...PAGE_QUERY,
      { name: "q", description: "Substring match on name or email.", schema: { type: "string" } },
    ],
    successSchema: envelope(ref("UserList")),
  },
  createUser: {
    description: "Create an account directly (separate from public registration). The password must satisfy the configured minimum length.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["email", "name", "password"],
        properties: {
          email: { type: "string", format: "email" },
          name: { type: "string", minLength: 1, maxLength: 120 },
          password: { type: "string", minLength: 8, maxLength: 256 },
          role: { type: "string", enum: ["admin", "user"], default: "user" },
          status: { type: "string", enum: ["active", "disabled"], default: "active" },
        },
      },
      example: { email: "operator@example.com", name: "Operator", password: "a-strong-password", role: "user" },
    },
    successStatus: 201,
    successSchema: envelope({ type: "object", properties: { user: ref("User") } }),
    errors: [400, 409],
  },
  getUser: {
    description: "User account plus the instances it owns.",
    successSchema: envelope({ type: "object", properties: { user: ref("User"), instances: { type: "array", items: ref("Instance") } } }),
    errors: [404],
  },
  updateUser: {
    description: "Update name, email, role, or status. Self-demotion, self-disable, and self-delete are rejected (`400 SELF_LOCKOUT`).",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 120 },
          email: { type: "string", format: "email" },
          role: { type: "string", enum: ["admin", "user"] },
          status: { type: "string", enum: ["active", "disabled"] },
        },
      },
      example: { role: "admin" },
    },
    successSchema: envelope({ type: "object", properties: { user: ref("User") } }),
    errors: [400, 404, 409],
  },
  deleteUser: {
    description: "Delete an account. Accounts that still own instances are rejected (409); instances are never destroyed implicitly.",
    successSchema: envelope({ type: "object", properties: { ok: { type: "boolean" } } }),
    errors: [400, 404, 409],
  },
  resetUserPassword: {
    description: "Set a new password and revoke every session belonging to that user.",
    requestBody: {
      required: true,
      schema: { type: "object", required: ["new_password"], properties: { new_password: { type: "string", minLength: 10, maxLength: 256 } } },
      example: { new_password: "a-strong-password" },
    },
    successSchema: envelope({ type: "object", properties: { ok: { type: "boolean" } } }),
    errors: [400, 404],
  },
  transferUserInstances: {
    description: "Transfer every instance owned by the user to another account.",
    requestBody: {
      required: true,
      schema: { type: "object", required: ["target_user_id"], properties: { target_user_id: { type: "string" } } },
      example: { target_user_id: "usr_1a2b3c4d5e6f7890" },
    },
    successSchema: envelope({ type: "object", properties: { transferred: { type: "integer" } } }),
    errors: [404],
  },
  assignInstanceToUser: {
    description: "Assign an existing instance to a user (ownership transfer of a single record).",
    requestBody: {
      required: true,
      schema: { type: "object", required: ["instance_id"], properties: { instance_id: { type: "string" } } },
      example: { instance_id: "vps_9f8e7d6c5b4a3928" },
    },
    successSchema: envelope({ type: "object", properties: { ok: { type: "boolean" } } }),
    errors: [404],
  },
  getPublicSettings: {
    description: "Public branding and policy settings used by the login page.",
    successSchema: envelope({ type: "object", properties: { settings: { type: "object", additionalProperties: { type: "string" } } } }),
    public: true,
  },
  getBrandingAsset: {
    description: "Logo or favicon bytes with the correct content type. 404 when no image is configured.",
    successSchema: { type: "object", properties: {} },
    errors: [404],
    public: true,
  },
  getSettings: {
    description: "Administrator settings plus runtime metadata (schema migration version, app version, Node version).",
    successSchema: envelope(ref("Settings")),
  },
  updateSettings: {
    description: "Update application identity, public registration policy, session lifetime, password policy, or timezone. Changes apply immediately.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        properties: {
          app_name: { type: "string", maxLength: 80 },
          app_description: { type: "string", maxLength: 500 },
          page_title: { type: "string", maxLength: 80 },
          registration_enabled: { type: "boolean" },
          session_ttl_hours: { type: "integer", minimum: 1, maximum: 720 },
          password_min_length: { type: "integer", minimum: 8, maximum: 64 },
          timezone: { type: "string", maxLength: 80 },
        },
      },
      example: { app_name: "KineticCT", registration_enabled: false, timezone: "UTC" },
    },
    successSchema: envelope({ type: "object", properties: { settings: { type: "object", additionalProperties: { type: "string" } } } }),
    errors: [400],
  },
  updateBranding: {
    description: "Upload or clear the logo and favicon as base64 data URLs (2 MB request cap). Raster formats only; magic bytes are verified server-side.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        properties: {
          logo: { type: "string", nullable: true, description: "Data URL, or null to clear." },
          favicon: { type: "string", nullable: true, description: "Data URL, or null to clear." },
        },
      },
    },
    successSchema: envelope({ type: "object", properties: { logo_url: { type: "string" }, favicon_url: { type: "string" } } }),
    errors: [400],
  },
  listAuditEvents: {
    description: "Sanitized audit events with filtering and pagination. Credential-like fields are redacted and Authorization headers are never recorded.",
    query: [
      ...PAGE_QUERY,
      { name: "action", description: "Exact action name.", schema: { type: "string" }, example: "instance.create" },
      { name: "actor_id", description: "Filter by acting user.", schema: { type: "string" } },
      { name: "target_type", description: "Filter by target type.", schema: { type: "string" }, example: "instance" },
      { name: "target_id", description: "Filter by target id.", schema: { type: "string" } },
      { name: "from", description: "Inclusive lower bound (ISO 8601).", schema: { type: "string", format: "date-time" } },
      { name: "to", description: "Inclusive upper bound (ISO 8601).", schema: { type: "string", format: "date-time" } },
    ],
    successSchema: envelope(ref("AuditList")),
    errors: [400],
  },
  listOperations: {
    description: "Long-running operation records. States only change when the underlying work actually changes; work interrupted by a restart is marked failed, never left pending.",
    query: [
      ...PAGE_QUERY,
      { name: "state", description: "Filter by state.", schema: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled", "all"] } },
      { name: "type", description: "Filter by operation type.", schema: { type: "string" }, example: "instance.create" },
      { name: "instance_id", description: "Filter by related instance.", schema: { type: "string" } },
      { name: "actor_id", description: "Filter by acting user.", schema: { type: "string" } },
    ],
    successSchema: envelope(ref("OperationList")),
    errors: [400],
  },
  getOperation: {
    description: "A single operation with its state, timing, and sanitized error.",
    successSchema: envelope({ type: "object", properties: { operation: ref("Operation") } }),
    errors: [404],
  },
  listScopes: {
    description:
      "The scope catalogue: every grantable scope with its label, group, description, and sensitivity flag. The same list drives the console UI, this document, and server-side enforcement.",
    successSchema: envelope(ref("ScopeCatalogue")),
  },
  listApiKeys: {
    description:
      "List API keys created by the calling key. Session administrators using the panel see every key; a Bearer key only ever sees its own children. Secrets are never included.",
    query: [
      ...PAGE_QUERY,
      { name: "q", description: "Substring match on name or key prefix.", schema: { type: "string" } },
      { name: "status", description: "Filter by status.", schema: { type: "string", enum: ["active", "expired", "revoked", "all"] } },
    ],
    successSchema: envelope(ref("ApiKeyList")),
  },
  createApiKey: {
    description:
      "Create a subordinate API key. The plaintext secret is returned once in this response and cannot be retrieved afterwards. A key can never grant a scope it does not itself hold, nor outlive its own expiration.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["name", "scopes"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          scopes: { type: "array", minItems: 1, items: { type: "string" }, description: "See the scope catalogue; `*` grants full access." },
          expires_at: { type: "string", format: "date-time", nullable: true, description: "Null or omitted = never expires (within the parent key's bound)." },
          ip_allowlist: { type: "array", items: { type: "string" }, description: "IPs or CIDR ranges. Malformed entries are rejected, never ignored." },
        },
      },
      example: { name: "Deployment Bot", scopes: ["instances:read", "instances:create"], expires_at: "2027-01-01T00:00:00Z" },
    },
    successStatus: 201,
    successSchema: envelope(ref("ApiKeyCreated")),
    errors: [400],
  },
  getApiKey: {
    description: "Metadata, scopes, restrictions, and sanitized usage for one key. The secret is never returned.",
    successSchema: envelope({ type: "object", properties: { key: ref("ApiKey") } }),
    errors: [404],
  },
  updateApiKey: {
    description: "Edit name, scopes, expiration, or IP restrictions. Editing metadata never changes the secret; scope changes take effect on the next request.",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          scopes: { type: "array", minItems: 1, items: { type: "string" } },
          expires_at: { type: "string", format: "date-time", nullable: true },
          ip_allowlist: { type: "array", items: { type: "string" } },
        },
      },
      example: { scopes: ["instances:read"] },
    },
    successSchema: envelope({ type: "object", properties: { key: ref("ApiKey") } }),
    errors: [400, 404],
  },
  rotateApiKey: {
    description:
      "Create a replacement with the same metadata and a fresh secret (201). Set `revoke_old: true` to revoke the original in the same call; leave it false to verify the new key first.",
    requestBody: {
      required: false,
      schema: { type: "object", properties: { revoke_old: { type: "boolean", default: false } } },
      example: { revoke_old: false },
    },
    successStatus: 201,
    successSchema: envelope({
      type: "object",
      properties: { key: ref("ApiKey"), secret: { type: "string" }, previous_key: ref("ApiKey") },
    }),
    errors: [400, 404],
  },
  revokeApiKey: {
    description: "Revoke a key immediately. Revocation is checked on every request (no restart) and cascades to keys created by it.",
    successSchema: envelope({ type: "object", properties: { key: ref("ApiKey") } }),
    errors: [404],
  },
};

/* ------------------------------------------------------------------ *
 * Document assembly
 * ------------------------------------------------------------------ */

function standardErrors(doc: DocEntry): [string, SchemaObject][] {
  const entries: [string, SchemaObject][] = [];
  if (!doc.public) {
    entries.push(errorResponse(401, "Missing, malformed, expired, or revoked API key."));
    entries.push(errorResponse(403, "Insufficient scope, IP restriction, or administrator role."));
  }
  for (const error of doc.errors ?? []) {
    if (typeof error === "number") {
      entries.push(errorResponse(error, defaultMessage(error)));
    } else {
      entries.push(errorResponse(error.status, error.description));
    }
  }
  entries.push(errorResponse(429, "Rate limit exceeded (see RateLimit-* and Retry-After headers)."));
  entries.push(errorResponse(500, "Unexpected server error; no stack traces are returned."));
  return entries;
}

function defaultMessage(status: number): string {
  switch (status) {
    case 400:
      return "Validation error with field-level details.";
    case 404:
      return "Resource not found (or not visible to this caller).";
    case 409:
      return "Conflict with the current state of the resource.";
    case 422:
      return "Semantically invalid input.";
    case 502:
      return "Infrastructure operation failed on the host.";
    default:
      return "Request failed.";
  }
}

function successResponse(spec: RouteSpec, doc: DocEntry): [string, SchemaObject] {
  const status = String(doc.successStatus ?? 200);
  const description = doc.successDescription ?? successDescription(spec);
  return [status, { description, content: { "application/json": { schema: doc.successSchema } } }];
}

function successDescription(spec: RouteSpec): string {
  const map: Record<string, string> = {
    POST: "Created.",
    PATCH: "Updated.",
    DELETE: "Deleted.",
    PUT: "Updated.",
    GET: "OK.",
  };
  return map[spec.method] ?? "OK.";
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const spec of ROUTE_REGISTRY) {
    const doc = DOCS[spec.operationId] ?? { description: spec.summary, successSchema: envelope({ type: "object", additionalProperties: true }) };
    const responses: Record<string, unknown> = {};
    const [successStatus, successBody] = successResponse(spec, doc);
    responses[successStatus] = successBody;
    for (const extra of doc.extraResponses ?? []) {
      responses[String(extra.status)] = {
        description: extra.description,
        content: { "application/json": { schema: extra.schema } },
      };
    }
    for (const [status, body] of standardErrors(doc)) {
      if (!responses[status]) responses[status] = body;
    }

    const operation: Record<string, unknown> = {
      operationId: spec.operationId,
      summary: spec.summary,
      description: doc.description,
      tags: [spec.tag],
      security: spec.scope === null ? [] : [{ bearerAuth: [] }],
      responses,
    };
    if (spec.scope !== null) {
      operation["x-scope"] = spec.scope;
      operation["x-scope-description"] = SCOPE_DEFINITIONS.find((s) => s.id === spec.scope)?.description ?? "";
    }
    if (spec.admin) operation["x-admin-role"] = true;
    if (spec.sensitive) operation["x-sensitive"] = true;

    const parameters = [...pathParameters(spec), ...(doc.query ?? [])];
    if (parameters.length > 0) operation.parameters = parameters;
    if (doc.requestBody) {
      operation.requestBody = {
        required: doc.requestBody.required ?? true,
        content: {
          "application/json": {
            schema: doc.requestBody.schema,
            ...(doc.requestBody.example ? { example: doc.requestBody.example } : {}),
          },
        },
      };
    }

    const key = `/api/v1${spec.path === "/" ? "" : spec.path}`;
    paths[key] = paths[key] ?? {};
    paths[key][spec.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "KineticCT API",
      version: APP_VERSION,
      summary: "Programmatic access to a self-hosted KineticCT installation.",
      description: [
        "Versioned REST API for KineticCT. Authenticate with `Authorization: Bearer <api key>`; session cookies are not accepted here.",
        "",
        "**Authorization** combines the API key's scopes with the role of the account that issued it: an administrator-issued key still needs the matching scope for every call, and scopes alone never grant administrator rights.",
        "",
        "**Responses** are `{ data, meta }` on success and `{ error: { code, message, request_id } }` on failure. Every response carries an `X-Request-Id` header.",
        "",
        "**Capabilities** are reported honestly: `/api/v1/capabilities` states what this installation supports, and unsupported operations fail with explicit codes instead of pretending to succeed.",
      ].join("\n"),
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: "/", description: "This installation" }],
    tags: [...new Set(ROUTE_REGISTRY.map((r) => r.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A KineticCT API key (`kct_live_…`). Create one in the panel under Administration → API Keys.",
        },
      },
      schemas: SCHEMAS,
    },
    "x-scopes": SCOPE_DEFINITIONS,
    "x-rate-limits": {
      general: { window: "1m", max: Number(process.env.API_RATE_LIMIT_MAX ?? 120), headers: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"] },
      sensitive: { window: "1m", max: Number(process.env.API_SENSITIVE_RATE_LIMIT_MAX ?? 20), applies_to: "credential, provisioning, deletion, node and settings endpoints" },
      auth_failures: { window: "5m", max: Number(process.env.API_AUTH_FAILURE_LIMIT ?? 30), response: 429 },
    },
  };
}
