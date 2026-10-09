# KineticCT API

Base path: `/api`. JSON only. Cookies carry the session (`kct_session` by default); include credentials from the browser. Mutating cookie-authenticated requests pass a same-origin check.

Error shape: `{ "error": { "code": "...", "message": "...", "details"?: [...] } }`.
Success shape: `{ "data": { ... } }`.

## Health

- `GET /api/health` → `{ ok: true, version }` (public).

## Auth

- `POST /api/auth/login` `{ email, password }` → `{ user }` + session cookie. Rate-limited. Generic `INVALID_CREDENTIALS` on failure.
- `POST /api/auth/logout` (auth) → clears session + cookie.
- `GET /api/auth/session` (auth) → `{ user }`.
- `POST /api/auth/register` `{ email, password, name }` → `201 { user }`, or `403 REGISTRATION_DISABLED` when disabled. First-ever user becomes `admin`.

## Profile (auth)

- `GET /api/me` → `{ user }`.
- `PATCH /api/me` `{ name?, email?, avatar_seed? }` → `{ user }`. `409 EMAIL_TAKEN` on clash.
- `POST /api/me/password` `{ current_password, new_password }` → `{ ok: true }`. Revokes other sessions.

## Instances (auth, owner-scoped)

- `GET /api/instances` → `{ instances: [...] }` (only the caller's).
- `GET /api/instances/:id` → `{ instance }` or `404` (ownership enforced).
- `POST /api/instances/:id/actions` `{ action: start|stop|restart|remove }` → `{ instance }` (or `{ removed: true }`). `409` when no node / unsupported; `502` with provider code when the host fails.
- `GET /api/templates` → `{ templates: [...] }` (supported LXC templates).

Instance fields: `id, name, container_id, node_id, node_name, status, cpu, memory_mb, storage_gb, template, ip_address, created_at, updated_at`.

## Settings

- `GET /api/settings/public` (public) → safe subset incl. `app_name`, `page_title`, `registration_enabled`.
- `GET /api/settings` (admin) → full managed set + `{ migration_version, app_version, node_version }`.
- `PATCH /api/settings` (admin) → partial update; `registration_enabled` accepts boolean/string.

## Nodes (admin)

Node list responses never include stored tokens.

- `GET /api/nodes` → `{ nodes: [{ id, name, endpoint, status, ... }], provider }`.
- `POST /api/nodes` `{ name, endpoint, api_token? }` → `201 { node }`. Use `endpoint: "local"` for the host agent.
- `POST /api/nodes/:id/test` → `{ status }` live check, or `502 NODE_UNREACHABLE`.
- `DELETE /api/nodes/:id` → `{ ok: true }`, or `409 NODE_IN_USE`.

## Admin

- `GET /api/admin/overview` → counts (users, containers total/running/stopped, nodes), node list, live utilization or honest `infra_status`, recent audit events, migration + app version.
- `GET /api/admin/users?page=&page_size=&q=` → `{ users: [...public fields + instance_count], pagination }`.
- `GET /api/admin/users/:id` → `{ user, instances }`.
- `PATCH /api/admin/users/:id` `{ name?, email?, role?, status? }` → `{ user }`. Self-demote/self-disable and self-delete are rejected (`SELF_LOCKOUT`).
- `POST /api/admin/users/:id/reset-password` `{ new_password }` → revokes all sessions.
- `POST /api/admin/users/:id/transfer-instances` `{ target_user_id }` → `{ transferred }`.
- `POST /api/admin/users/:id/assign-instance` `{ instance_id }` → `{ ok: true }`.
- `DELETE /api/admin/users/:id` → `{ ok: true }`, or `409 HAS_INSTANCES` (transfer/remove first; never implicitly destroyed).
- `POST /api/admin/instances` `{ name, node_id, owner_id, template, cpu, memory_mb, storage_gb, container_id? }` → `201 { instance }`. Validates everything, reserves the id, creates via the host agent, marks `failed` + audits on partial failure instead of reporting success.
