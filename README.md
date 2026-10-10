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
| `--skip-lxc` | Skip automatic LXC host setup (panel only). |
| `--setup-lxc-only` | Only configure LXC on this host for an EXISTING installation (see below). Requires root. |
| `--repair` | Reconcile EXISTING managed VPS configs (limits, affinity, LXCFS include, btrfs quotas). Never touches `.env`, users, settings, ports, or service config. Requires root. |
| `--probe` | Run a full create/start/stop/destroy probe container during verification. |
| `--start` | Launch the server in the foreground when finished. |
| `--dir DIR` / `--branch NAME` | Control where the auto-clone goes / which branch it uses. |

## LXC host setup

On a fresh install the installer also prepares the local virtualization host automatically (Debian/Ubuntu, x86_64/aarch64, root required): it installs the LXC userspace (`lxc`, `uidmap`, `libpam-cgfs`, bridge/dnsmasq/squashfs helpers), ensures subordinate UID/GID mappings, brings up the `lxcbr0` container bridge via `lxc-net` when missing (existing bridges, Netplan/NetworkManager rules, and firewall rules are never touched), verifies the tooling is runnable by the panel's service account, and reports the real result. Nothing is overwritten blindly: existing LXC installs are reused, and config backups (`*.kct-bak`) are kept for edited files.

Hosts that cannot run nested containers (Docker/LXC/OpenVZ guests without nesting) are detected up front and reported as unsupported instead of failing halfway — move to a KVM VPS with nesting enabled by your provider in that case.

### Existing installation: set up LXC without reinstalling

If KineticCT is already installed and running, configure LXC on that same host with:

```bash
cd /root/KineticContainers && git pull --ff-only && ./install.sh --setup-lxc-only
```

Setup-only mode performs host LXC setup, runtime permission checks, a capability probe (temporary `kct-probe-*` container, always cleaned up), panel health verification, and a real Local Node health check through the backend. It never touches `.env`, the database contents (besides node health columns), users, settings, ports, service config, existing containers, or firewall rules.

### Verifying the Local Node

1. Open **Nodes** in the admin sidebar — the host appears as `Local Node`.
2. Press **Refresh** (or open **Details**) to run a live health check.
3. `Online` means LXC answered and inventory was readable; the details dialog shows host resources, a readiness checklist (tooling, nesting, userns, cgroup, bridge, forwarding), and the detected containers.
4. `Unconfigured` means LXC is not installed — run the setup command above. `Error` with "Permission denied" means the backend user cannot execute the LXC tooling (run the panel as root or fix permissions; never add blanket `NOPASSWD: ALL` sudo rules).

### Classic LXC vs LXD

KineticCT uses **classic LXC** (`lxc-ls`, `lxc-info`, `lxc-create`, `lxc-start`, `lxc-stop`, `lxc-destroy`, `lxc-attach`), as shipped by Debian 13 in the `lxc` package (6.0.x). There is intentionally **no `lxc` binary** — `lxc list` is LXD/Incus syntax, so `lxc: command not found` does **not** mean LXC is broken. Do not install LXD/Incus for this panel; they are a different runtime with an incompatible CLI.

Verify the real tooling on the host with:

```bash
command -v lxc-ls lxc-info lxc-create lxc-start lxc-stop lxc-destroy lxc-attach lxc-cgroup lxc-wait
lxc-ls --version
test -f /usr/share/lxc/templates/lxc-download && echo "download template present"
lxc-ls -f
```

The installer checks every binary above by name, executes `--version` on the core tools, confirms the download template exists, and only reports success when `lxc-ls -f` really lists. The final report prints this evidence; if tooling is still missing it exits nonzero instead.

### Resource enforcement model

Each VPS gets a **hard CPU quota** (`cpu.max` / `cfs_quota_us`) plus a **shared CPU affinity set** (`cpuset.cpus`, sized to the vCPU allocation) and a **hard memory limit** (`memory.max` / `limit_in_bytes`), written to the container config, verified by read-back, and live-applied when running. Cores are shared with the host — KineticCT never claims dedicated physical cores. Affinity sets make guest-visible CPU enumeration (`nproc`, Neofetch) match the allocation; **LXCFS** (installed and enabled automatically on Debian/Ubuntu) provides container-aware `/proc/meminfo`, `/proc/cpuinfo`, `/proc/stat`, `/proc/uptime`, `/proc/swaps`, and `/sys/devices/system/cpu/online` views. Without LXCFS, guests show host resource info — the Nodes readiness checklist and each VPS Resources tab report this honestly.

Storage depends on the detected backend: containers on **btrfs subvolumes** get real enforced quotas (`btrfs qgroup limit`, verified by read-back); plain directories (the default) have no quota mechanism, so the panel records the allocation, shows real measured usage, and states that quotas are unenforced. Guest `df` shows filesystem totals even under quota — the UI shows the enforced quota separately and explains the distinction.

### Repairing existing VPS

If containers were created before limits were enforced (or drifted), reconcile them without recreating anything:

```bash
cd /root/KineticContainers && git pull --ff-only && ./install.sh --repair
```

Repair compares each managed container against its allocation, backs up its config once (`config.kct-bak`, never overwritten), re-applies CPU/memory/affinity, adds the LXCFS include, and enforces btrfs quotas where supported — then reports per-container results and whether a restart is needed. The same plan/apply flow is available per-VPS from the Resources tab ("Check for drift" / "Apply repair").

### VPS management and console

Each VPS has a dedicated page at `/instances/:id` (linked from the dashboard via its name or **Manage**) with Overview, Console, Resources, Network, and Settings tabs. Power actions are confirmed against the live container state before the database is updated; CPU/memory limits are enforced through host cgroup settings (v1 or v2, detected automatically); disk quotas are **not** enforced by the directory backend and the UI says so.

The Console tab attaches to the running container via `lxc-attach` over an authenticated WebSocket (`node-pty` required on the host — it is an optional dependency, and the tab reports honestly when it is missing). Sessions enforce ownership, expire after 15 minutes idle, and never reach the host shell.

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

## Node management

The admin **Nodes** page (`/admin/nodes`) manages the hosts that run LXC containers.

- **Local Node:** on first boot (and every boot, idempotently) the backend registers its own host as node id `local` named "Local Node" (migration v2 + boot-time `ensureLocalNode`). It can be renamed but never converted to a remote node or deleted. Duplicate local rows from older databases are merged on upgrade without touching instances.
- **Health checks:** opening node details (or Refresh) runs a live check — LXC tooling presence, inventory readability, host resources (hostname, OS, kernel, arch, memory, CPU sample, root filesystem, container counts) — and persists status (`online` / `unconfigured` / `unavailable` / `error` / `offline`), last-check time, and last-known-good inventory. Metrics that cannot be collected show as `Unavailable`, never invented.
- **Host dependencies:** `lxc-ls` (and friends) must be on `PATH` and executable by the backend user (typically root for container operations). Missing tooling reports `Unconfigured` with an explanation; permission problems report `Error`.
- **Remote nodes:** can be saved as configuration records (name + host address) but stay `Unconfigured` — connectivity checks and inventory honestly return `REMOTE_NODE_UNSUPPORTED` until a secure remote agent is implemented. Removing a registration never touches host containers; nodes with managed instances cannot be removed until reassigned.

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
