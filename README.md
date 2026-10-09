# KineticCT

KineticCT is a self-hostable, open-source control panel for managing LXC containers and virtual servers. Monochrome UI, email-and-password authentication, per-user instance isolation, an administrator panel (Overview, Users, Create, Settings), and a narrowly privileged host-side LXC integration behind a provider abstraction.

- Frontend: React + TypeScript + Tailwind CSS + lucide-react, served or run via Vite.
- Backend: TypeScript Node.js API (Express) with SQLite (`better-sqlite3`), Argon2id password hashing, HTTP-only session cookies.
- Virtualization: `VirtualizationProvider` interface + local LXC host agent (`lxc-*` via safe argument vectors). No node configured → the UI reports “unavailable” honestly instead of fabricating data.

## Install (one shot)

Prerequisites: a Linux host with bash. The installer auto-installs system dependencies when missing (git, curl, Node.js 22+, C++ build tools for native modules, PM2) using apt/dnf/yum/zypper/pacman/apk/brew — pass `--no-system-deps` to require them preinstalled instead. Project dependencies are installed with npm automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/xAyan55/KineticContainers/main/install.sh | bash
```

Or, from a local clone:

```bash
./install.sh
```

The installer asks for every setting (port, admin email/password, session lifetime, …) with sensible defaults, writes a `0600` `.env` (backing up any existing one), installs dependencies, builds the frontend and backend, applies database migrations, and keeps the panel running via PM2 (default, with boot hook) or a `kineticct` systemd service. Manage a PM2 install with `pm2 [logs|restart|stop|monit] kineticct`. Useful flags:

| Flag | Effect |
|---|---|
| `--yes` | Accept all defaults (reads answers from the environment when exported, e.g. `SEED_ADMIN_EMAIL=…`). Generates a strong admin password if none is given. |
| `--non-interactive` | Like `--yes`, but fail instead of guessing when a required value has no default. |
| `--service pm2\|systemd\|none` | How to keep the panel running on boot (default: `pm2`). |
| `--no-service` | Skip the systemd service prompt. |
| `--start` | Launch the server in the foreground when finished. |
| `--dir DIR` / `--branch NAME` | Control where the auto-clone goes / which branch it uses. |

## Quick start (development)

Prerequisites: Node.js 22+, npm.

```bash
cp .env.example .env
npm install
npm run migrate --workspace=server   # optional; the server migrates on boot too
npm run dev:server                   # API on http://127.0.0.1:8080
npm run dev:frontend                 # UI on http://127.0.0.1:5173 (proxies /api)
```

On first boot with an empty database, the server creates an initial administrator from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (see `.env.example`). Change that password immediately after signing in.

## Production (single process)

```bash
npm run build --workspace=frontend
npm run build --workspace=server
DATABASE_PATH=/var/lib/kineticct/kineticct.sqlite NODE_ENV=production PORT=8080 node server/dist/index.js
```

When `frontend/dist` exists, the API serves it directly, so one process hosts both. Put a reverse proxy (Caddy, nginx) in front for TLS. Set `Secure` cookies automatically via `NODE_ENV=production`.

## Configuration

See `.env.example` for all variables. Key settings:

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | API listen port | `8080` |
| `DATABASE_PATH` | SQLite file | `./data/kineticct.sqlite` |
| `VITE_API_BASE_URL` | API URL baked into the frontend build | `http://127.0.0.1:8080` |
| `SESSION_COOKIE_NAME` / `SESSION_TTL_HOURS` | cookie name / lifetime | `kct_session` / `168` |
| `CORS_ORIGINS` | allowed browser origins | Vite dev origins |
| `SEED_ADMIN_*` | first-boot admin | `admin@example.invalid` (no default password) |
| `LOGIN_RATE_LIMIT_MAX` | login attempts per 15 min / IP | `20` |

Runtime settings (persisted in SQLite, editable at `/admin/settings`): application name, description, page title, registration toggle (default off), session TTL, password policy, timezone, nodes.

## LXC integration status

- `server/src/services/virtualization/provider.ts` defines `VirtualizationProvider`.
- `server/src/services/virtualization/localAgent.ts` implements it for the local host using `lxc-ls`, `lxc-create`, `lxc-start`, `lxc-stop`, `lxc-destroy` with timeouts, bounded output, strict identifier validation, and no shell-string concatenation.
- Remote nodes: an endpoint other than `local` is accepted for inventory but operations return `REMOTE_NODE_UNSUPPORTED` until a real encrypted agent exists.
- No node registered: provider is `unconfigured`; Overview shows “No virtualization node configured”, Create is unavailable, instance actions return `409` with an honest message.

## Security model

- Argon2id password hashing; sessions are random 256-bit tokens stored as SHA-256 hashes, HTTP-only `SameSite=Lax` cookies (`Secure` in production).
- Same-origin check for cookie-authenticated mutations, login rate limiting, generic login errors, server-side validation (zod), ownership checks on every instance request, role checks on every admin route, audit log for sensitive operations.
- Registration disabled by default and enforced server-side (frontend route hides, API returns `403`).

## API

See [`docs/API.md`](docs/API.md). Health: `GET /api/health`.

## Tests

```bash
npm run test --workspace=server      # vitest + supertest: auth, RBAC, isolation, registration toggle
npm run typecheck --workspaces
```

## Project structure

```text
frontend/src/
  App.tsx  main.tsx
  components/ui/  (primitives, modern-login-signup)
  components/layout/  (AppShell, AdminLayout)
  features/auth/  pages/  lib/
server/src/
  app.ts  index.ts  db.ts  migrate.ts
  middleware/  routes/  services/virtualization/
```

## License

MIT — see [`LICENSE`](LICENSE). No commercial branding, demo credentials, or fake data are bundled; avatars are generated locally with DiceBear (Lorelei).
