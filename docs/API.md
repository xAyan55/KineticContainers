# KineticCT API

KineticCT exposes two surfaces, both JSON-only:

- **`/api/v1` — the versioned public API.** Authenticate with an API key sent as
  `Authorization: Bearer <key>`. This is what automation, CI, and integrations use.
- **`/api` — the panel's own endpoints.** Authenticate with the session cookie the
  browser holds. These are what the web UI calls; they are not part of the stable
  contract below except where noted.

Interactive reference: **`/api/docs`** (offline explorer). Machine-readable spec:
**`/api/docs/openapi.json`** (also committed at `docs/openapi.json`).

---

## 1. Quick start

1. Sign in to the panel as an administrator and open **API Keys**.
2. Create a key, choosing the narrowest set of scopes that works. The secret is shown
   exactly once — copy it immediately.
3. Call the API:

```bash
export KCT_BASE_URL="https://your-panel.example.com"
export KCT_API_KEY="kct_live_ab12cd34ef56_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

curl -s "$KCT_BASE_URL/api/v1/health"                       # public
curl -s -H "Authorization: Bearer $KCT_API_KEY" \
     "$KCT_BASE_URL/api/v1/instances?page=1&page_size=25"
```

Every key starts with `kct_live_`. The token format is
`kct_live_<12 hex public id>_<43-char base64url secret>`. The public id and a SHA-256
hash of the secret are stored; the plaintext secret never is.

## 2. Conventions

- All request and response bodies are `application/json`.
- Success responses are wrapped in `data`:

  ```json
  { "data": { "instances": [] }, "meta": { "request_id": "req_..." } }
  ```

- Errors are wrapped in `error`, and echo the same request id:

  ```json
  { "error": { "code": "INSUFFICIENT_SCOPE", "message": "..." }, "meta": { "request_id": "req_..." } }
  ```

- Every response carries an `X-Request-Id` header. Include it when reporting a problem.
- Timestamps are ISO-8601 UTC strings.
- Paginated collections accept `page` (1-based) and `page_size` (max 100) and return a
  `pagination` object: `{ page, page_size, total, pages }`.
- Mutating requests must be sent with `Content-Type: application/json`.

## 3. Authentication

Send the key on every request:

```
Authorization: Bearer kct_live_...
```

- A missing `Authorization` header falls through as an anonymous request; public
  operations succeed and protected operations return `401`.
- A malformed header returns `401 INVALID_AUTH_HEADER`.
- The key's **owner account** must still exist and be `active`; otherwise the request
  fails with `401 API_KEY_OWNER_UNAVAILABLE`.
- An API key **never** grants administrator role. It is bound by the scopes you grant
  and only ever sees the resources its owner is allowed to see.
- Session cookies are **not** accepted on `/api/v1`. Use the panel or the `/api`
  endpoints for cookie-authenticated browser calls.

### Authentication failures

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `INVALID_AUTH_HEADER` | Header missing the `Bearer` scheme or otherwise malformed. |
| 401 | `INVALID_API_KEY` | Unknown key: wrong prefix, unknown id, or secret hash mismatch. |
| 401 | `API_KEY_EXPIRED` | The key's `expires_at` has passed. |
| 401 | `API_KEY_REVOKED` | The key was revoked. |
| 401 | `API_KEY_OWNER_UNAVAILABLE` | The issuing account was deleted or disabled. |
| 403 | `IP_NOT_ALLOWED` | The client IP is outside the key's allowlist. |
| 403 | `INSUFFICIENT_SCOPE` | The key lacks the scope required by the operation. |

Failure reasons are deliberately generic where distinguishing them would help an
attacker (unknown id and bad secret both return `INVALID_API_KEY`).

## 4. Scopes

Scopes are the single source of truth shared by the enforcement layer, the admin UI,
and this document (also emitted as `x-scope` on each OpenAPI operation). Request only
what a key needs.

| Scope | Group | Sensitive | Grants |
| --- | --- | --- | --- |
| `system:read` | System | | Health, version, capabilities, identity, overview, operation status. |
| `users:read` | Users | | List and inspect users. |
| `users:create` | Users | ✓ | Create accounts. |
| `users:update` | Users | ✓ | Edit accounts, reset passwords, transfer instances, edit own profile/password. |
| `users:delete` | Users | ✓ | Delete accounts without instances. |
| `instances:read` | Instances | | List/inspect instances, live status, templates, console preflight. |
| `instances:create` | Instances | ✓ | Provision containers. |
| `instances:power` | Instances | ✓ | Start/stop/restart. |
| `instances:delete` | Instances | ✓ | Destroy containers. |
| `instances:resources:read` | Instances | | Read CPU/memory/disk limits and usage. |
| `instances:resources:write` | Instances | ✓ | Change limits and run resource repairs. |
| `instances:network:read` | Instances | | Read container network config and addresses. |
| `instances:settings:write` | Instances | ✓ | Rename / edit instance metadata. |
| `nodes:read` | Nodes | | List and inspect nodes. |
| `nodes:create` | Nodes | ✓ | Register nodes. |
| `nodes:update` | Nodes | ✓ | Edit node metadata. |
| `nodes:delete` | Nodes | ✓ | Remove eligible node registrations. |
| `nodes:health:check` | Nodes | | Run node health checks and connectivity tests. |
| `nodes:containers:read` | Nodes | | List containers known to a node. |
| `settings:read` | Settings & audit | | Read administrator-visible settings. |
| `settings:write` | Settings & audit | ✓ | Update settings and branding. |
| `audit:read` | Settings & audit | | Read sanitized audit events. |
| `api_keys:read` | API keys | | Read key metadata (never secrets). |
| `api_keys:create` | API keys | ✓ | Mint subordinate keys. |
| `api_keys:update` | API keys | ✓ | Edit subordinate keys. |
| `api_keys:revoke` | API keys | ✓ | Revoke or rotate subordinate keys. |

`*` (**Full access**) grants every scope, present and future. Use it only for fully
trusted automation.

**Delegation rules.** A key may only manage keys it created. A child key can never be
granted a scope the parent lacks, cannot outlive the parent's expiration, and is
revoked when the parent is. Scope checks are strictly enumerated — a request that does
not match a known route is rejected with `404` before any handler runs.

Fetch the catalogue at runtime from `GET /api/v1/api-keys/scopes`.

## 5. Rate limits

Limits are per key (falling back to per client IP for unauthenticated public calls) in
a fixed one-minute window. Sensitive operations are counted separately against a
smaller budget.

| Limit | Default | Env override |
| --- | --- | --- |
| General | 120 / minute | `API_RATE_LIMIT_MAX` |
| Sensitive | 20 / minute | `API_SENSITIVE_RATE_LIMIT_MAX` |
| Failed auth attempts | 30 / 5 minutes | `API_AUTH_FAILURE_LIMIT` |

Responses include `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
(seconds until reset) and the `X-RateLimit-*` equivalents. When exceeded the API
returns `429 RATE_LIMITED` with a `Retry-After` header. Too many authentication
failures from one client also return `429`.

## 6. Endpoints

All paths below are relative to `/api/v1`. The **Scope** column lists the required
scope; *(public)* means no key is needed.

### 6.1 Metadata

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/health` | *(public)* | `{ ok, version }`. |
| GET | `/version` | *(public)* | App, node, and migration versions. |
| GET | `/capabilities` | *(public)* | Provider, node types, features. |
| GET | `/me` | `system:read` | The calling key's identity and granted scopes. |
| PATCH | `/me` | `users:update` | Update the owner's `name` / `email` / `avatar_seed`. |
| POST | `/me/password` | `users:update` | `{ current_password, new_password }`; revokes other sessions. |
| GET | `/overview` | `system:read` | Dashboard counts, nodes, utilization, recent audit. |
| GET | `/operations` | `system:read` | List long-running operations. |
| GET | `/operations/:id` | `system:read` | Poll one operation. |

### 6.2 Auth (useful for API-only tooling)

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| POST | `/auth/login` | *(public)* | `{ email, password }` → session cookie. |
| POST | `/auth/logout` | *(public)* | Clears the session. |
| GET | `/auth/session` | *(public)* | Current session user, or `401`. |
| POST | `/auth/register` | *(public)* | `201 { user }`, or `403 REGISTRATION_DISABLED`. |

### 6.3 Instances

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/instances` | `instances:read` | Filters: `status`, `node_id`, `owner_id` (admins), `template`, `q`. |
| POST | `/instances` | `instances:create` | Provision. `201` sync, `202` with `async: true`. |
| GET | `/instances/:id` | `instances:read` | Ownership enforced (admins see all). |
| PATCH | `/instances/:id` | `instances:settings:write` | Rename. |
| DELETE | `/instances/:id` | `instances:delete` | Destroy + remove record. |
| GET | `/instances/:id/live` | `instances:read` | Live status, metrics, storage. |
| GET | `/instances/:id/network` | `instances:network:read` | Live network config/addresses. |
| GET | `/instances/:id/config` | `instances:resources:read` | Allocated and enforced limits. |
| PATCH | `/instances/:id/resources` | `instances:resources:write` | Change CPU / memory / disk. |
| GET | `/instances/:id/repair` | `instances:resources:read` | Preview a resource-repair plan. |
| POST | `/instances/:id/repair` | `instances:resources:write` | Apply the repair. |
| GET | `/instances/:id/console` | `instances:read` | Console **preflight** only — see §9. |
| POST | `/instances/:id/actions` | `instances:power` | `{ action: start\|stop\|restart\|remove }`. |
| GET | `/templates` | `instances:read` | Supported templates. |

**Create an instance**

```bash
curl -s -X POST "$KCT_BASE_URL/api/v1/instances" \
  -H "Authorization: Bearer $KCT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "web-1",
        "node_id": "node-local",
        "owner_id": "usr_...",
        "template": "ubuntu-24.04",
        "cpu": 2,
        "memory_mb": 2048,
        "storage_gb": 20,
        "async": true
      }'
```

With `async: true` the response is `202` and contains an `operation`; poll
`GET /api/v1/operations/{id}` until `state` is `succeeded` or `failed`. Without it the
call blocks and returns `201 { instance, operation }`. Invalid input returns `400`;
host failures return `502` with a provider code (`409` for a conflicting reservation).

### 6.4 Nodes (administrators)

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/nodes` | `nodes:read` | Tokens are never returned. |
| POST | `/nodes` | `nodes:create` | Register `local` or `remote`. |
| GET | `/nodes/:id` | `nodes:read` | Includes `managed_containers`. |
| PATCH | `/nodes/:id` | `nodes:update` | Display name only; identity is immutable. |
| DELETE | `/nodes/:id` | `nodes:delete` | `403 NODE_PROTECTED` for the Local Node; `409 NODE_IN_USE`. |
| POST | `/nodes/:id/check` | `nodes:health:check` | Real health check; remote → `409 REMOTE_NODE_UNSUPPORTED`. |
| POST | `/nodes/:id/test` | `nodes:health:check` | Connectivity test; `502 NODE_UNREACHABLE`. |
| GET | `/nodes/:id/containers` | `nodes:containers:read` | Managed + unmanaged containers. |

### 6.5 Users (administrators)

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/users` | `users:read` | `page`, `page_size`, `q`. |
| POST | `/users` | `users:create` | Create an account. |
| GET | `/users/:id` | `users:read` | User + owned instances. |
| PATCH | `/users/:id` | `users:update` | `name?`, `email?`, `role?`, `status?`. Self-lockout → `409 SELF_LOCKOUT`. |
| DELETE | `/users/:id` | `users:delete` | `409 HAS_INSTANCES` if the user still owns instances. |
| POST | `/users/:id/reset-password` | `users:update` | `{ new_password }`; revokes sessions. |
| POST | `/users/:id/transfer-instances` | `users:update` | `{ target_user_id }`. |
| POST | `/users/:id/assign-instance` | `users:update` | `{ instance_id }`. |

### 6.6 Settings & branding

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/settings/public` | *(public)* | Safe subset incl. `app_name`, `page_title`, `registration_enabled`. |
| GET | `/settings/branding/:kind` | *(public)* | `kind` = `logo` \| `favicon`; image bytes. |
| GET | `/settings` | `settings:read` | Full managed set + versions. |
| PATCH | `/settings` | `settings:write` | Partial update. |
| POST | `/settings/branding` | `settings:write` | Raster data URLs (≤ 2 MB body). Magic bytes verified; SVG rejected. |

### 6.7 Audit

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/audit/events` | `audit:read` | Filters + pagination; events are redacted before they leave the server. |

### 6.8 API key management (via API)

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/api-keys` | `api_keys:read` | Only keys created by the calling key. |
| POST | `/api-keys` | `api_keys:create` | `201 { key, secret }` — `secret` shown once. |
| GET | `/api-keys/scopes` | `api_keys:read` | The scope catalogue. |
| GET | `/api-keys/:id` | `api_keys:read` | Metadata only. |
| PATCH | `/api-keys/:id` | `api_keys:update` | Name, scopes, expiry, allowlist. |
| DELETE | `/api-keys/:id` | `api_keys:revoke` | Revoke (cascades to children). |
| POST | `/api-keys/:id/rotate` | `api_keys:revoke` | New secret; `revoke_old` defaults `false`. |

## 7. Operations

Long-running work (currently instance provisioning) is represented as an operation:

```json
{
  "id": "op_...",
  "type": "instance.create",
  "state": "queued",
  "instance_id": "vps_...",
  "actor_id": "usr_...",
  "actor_key_id": "kct_...",
  "detail": { "name": "web-1" },
  "error": null,
  "progress": null,
  "created_at": "...",
  "started_at": null,
  "finished_at": null,
  "duration_ms": null
}
```

`state` is one of `queued`, `running`, `succeeded`, `failed`, `interrupted`. Operations
left running when the server restarts are marked `interrupted` at boot so a client is
never left polling forever.

## 8. Error codes

| Code | Typical status | Meaning |
| --- | --- | --- |
| `VALIDATION` | 400 | Request body/query failed validation; `details` lists fields. |
| `NOT_FOUND` | 404 | Unknown route or resource (also used to avoid enumerating others' keys). |
| `INSUFFICIENT_SCOPE` | 403 | Key lacks the required scope. |
| `IP_NOT_ALLOWED` | 403 | Client IP not in the key's allowlist. |
| `INVALID_AUTH_HEADER` / `INVALID_API_KEY` | 401 | Bad or unknown credentials. |
| `API_KEY_EXPIRED` / `API_KEY_REVOKED` / `API_KEY_OWNER_UNAVAILABLE` | 401 | Key no longer usable. |
| `RATE_LIMITED` | 429 | Slow down; see `Retry-After`. |
| `REGISTRATION_DISABLED` | 403 | Registration turned off. |
| `SELF_LOCKOUT` | 409 | Refused to disable/demote/delete your own admin account. |
| `HAS_INSTANCES` / `NODE_IN_USE` / `NODE_PROTECTED` | 409/403 | Resource constraint. |
| `REMOTE_NODE_UNSUPPORTED` / `NODE_UNREACHABLE` | 409/502 | Node cannot serve the request. |
| provider codes | 4xx/5xx | `instance.create` etc. surfaced from the virtualization provider. |

## 9. Known limitations

- **Interactive console.** The browser console is a WebSocket and requires a session
  cookie on the panel origin. `GET /api/v1/instances/:id/console` returns a
  preflight/availability result only; it does **not** open a terminal for API-key
  clients.
- **Branding uploads** accept raster images only (PNG/JPEG/WebP/GIF, plus ICO for the
  favicon). SVG is rejected.
- **Remote nodes** are recorded as configuration only; node-level operations on them
  return `REMOTE_NODE_UNSUPPORTED` rather than faking success.

## 10. Client examples

### TypeScript

```ts
const BASE = process.env.KCT_BASE_URL!;
const KEY = process.env.KCT_API_KEY!;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.data as T;
}

const { instances } = await call<{ instances: unknown[] }>("/instances?page_size=100");
```

### Python

```python
import os, requests

BASE = os.environ["KCT_BASE_URL"]
HEADERS = {"Authorization": f"Bearer {os.environ['KCT_API_KEY']}"}

def call(method, path, **kw):
    r = requests.request(method, f"{BASE}/api/v1{path}", headers=HEADERS, timeout=30, **kw)
    body = r.json()
    if not r.ok:
        raise RuntimeError(f"{body['error']['code']}: {body['error']['message']}")
    return body["data"]

# Sync provision, then poll an async one
inst = call("POST", "/instances", json={
    "name": "web-1", "node_id": "node-local", "owner_id": "usr_...",
    "template": "ubuntu-24.04", "cpu": 2, "memory_mb": 2048, "storage_gb": 20,
})["instance"]

op = call("POST", "/instances", json={**{}, "name": "worker-1", "node_id": "node-local",
          "owner_id": "usr_...", "template": "ubuntu-24.04", "cpu": 1,
          "memory_mb": 1024, "storage_gb": 10, "async": True})["operation"]
while op["state"] in ("queued", "running"):
    op = call("GET", f"/operations/{op['id']}")
```

## 11. The `/api` panel surface

The browser UI continues to use the older, unversioned routes under `/api`
(cookie-authenticated). They share the same handlers and services as `/api/v1` but are
not part of the stable public contract. Administrators manage keys from the panel's
**API Keys** page, which calls `/api/admin/api-keys`.
