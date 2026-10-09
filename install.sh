#!/usr/bin/env bash
#
# KineticCT — one-shot installer.
#
# Usage:
#   ./install.sh [options]
#   curl -fsSL https://raw.githubusercontent.com/xAyan55/KineticContainers/main/install.sh | bash -s -- [options]
#
# Options:
#   -y, --yes             Accept defaults for every prompt (still asks nothing).
#       --non-interactive Same as --yes, but fail if a required value has no
#                         default instead of falling back silently.
#       --service WHICH   Keep the panel running on boot via pm2 (default),
#                         systemd, or none.  May also be set with SERVICE=...
#       --no-service      Same as --service none.
#       --no-system-deps  Do not install system packages (git, Node.js, build
#                         tools) — fail instead if they are missing.
#       --start           Start the server in the foreground when finished.
#       --dir DIR         Install directory when cloning (default: $HOME/KineticContainers).
#       --branch NAME     Git branch to clone (default: main).
#   -h, --help            Show this help.
#
# System dependencies (git, curl, Node.js 22+, C++ build tools for native
# modules) are installed automatically on Linux when missing. Project
# dependencies are always installed with npm further down.
#
# Every prompt can also be answered non-interactively by exporting the
# corresponding variable before running, e.g.:
#   SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD=... ./install.sh --yes
#
set -euo pipefail

REPO_URL="https://github.com/xAyan55/KineticContainers.git"
DEFAULT_BRANCH="main"

YES=0
NON_INTERACTIVE=0
NO_SERVICE=0
SYS_DEPS=1
SERVICE="${SERVICE:-}"
START_NOW=0
INSTALL_DIR="${INSTALL_DIR:-$HOME/KineticContainers}"
BRANCH="main"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  ✕ %s\033[0m\n' "$*" >&2; exit 1; }

# Interactive input must come from the terminal even when this script itself
# is piped in via `curl ... | bash`.
TTY_IN="/dev/tty"
if [ -t 0 ]; then TTY_IN="/dev/stdin"; fi

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \?//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; YES=1; shift ;;
    --service) SERVICE="$2"; shift 2 ;;
    --service=*) SERVICE="${1#--service=}"; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    --no-system-deps) SYS_DEPS=0; shift ;;
    --start) START_NOW=1; shift ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#--dir=}"; shift ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --branch=*) BRANCH="${1#--branch=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# system dependencies (git, curl, Node.js 22+, build tools)
# ---------------------------------------------------------------------------
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ON_WINDOWS=1;; *) ON_WINDOWS=0;; esac

PKG_MGR=""
detect_pkg_mgr() {
  [ -n "$PKG_MGR" ] && return 0
  if command -v apt-get >/dev/null 2>&1; then PKG_MGR=apt
  elif command -v dnf >/dev/null 2>&1; then PKG_MGR=dnf
  elif command -v yum >/dev/null 2>&1; then PKG_MGR=yum
  elif command -v zypper >/dev/null 2>&1; then PKG_MGR=zypper
  elif command -v pacman >/dev/null 2>&1; then PKG_MGR=pacman
  elif command -v apk >/dev/null 2>&1; then PKG_MGR=apk
  elif command -v brew >/dev/null 2>&1; then PKG_MGR=brew
  else return 1; fi
}

# Run a command with root rights (directly, via sudo, or not at all).
run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else return 126; fi
}

pkg_install() {
  detect_pkg_mgr || return 1
  case "$PKG_MGR" in
    apt) run_root apt-get update -qq && run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf) run_root dnf install -y -q "$@" ;;
    yum) run_root yum install -y -q "$@" ;;
    zypper) run_root zypper --non-interactive -q in "$@" ;;
    pacman) run_root pacman -Sy --noconfirm --needed "$@" ;;
    apk) run_root apk add --quiet "$@" ;;
    brew) brew install "$@" ;;
    *) return 1 ;;
  esac
}

# git + curl must exist before we can clone or download anything.
ensure_base_tools() {
  [ "$ON_WINDOWS" -eq 1 ] && return 0
  local need=()
  command -v git >/dev/null 2>&1 || need+=(git)
  command -v curl >/dev/null 2>&1 || need+=(curl)
  [ "${#need[@]}" -eq 0 ] && return 0
  [ "$SYS_DEPS" -eq 0 ] && die "Missing required tools: ${need[*]} (auto-install disabled by --no-system-deps)."
  say "Installing system packages: ${need[*]} ..."
  pkg_install "${need[@]}" || die "Could not install ${need[*]}. Install them manually and re-run."
  hash -r 2>/dev/null || true
}

# True when node 22+ and npm are usable.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  command -v npm >/dev/null 2>&1 || return 1
  [ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -ge 22 ]
}

# Guaranteed-22 Node.js from the official builds (distro repos are too old).
install_nodejs() {
  [ "$ON_WINDOWS" -eq 1 ] && die "Node.js 22+ is required. Install it from https://nodejs.org and re-run."
  [ "$SYS_DEPS" -eq 0 ] && die "Node.js 22+ is required (auto-install disabled by --no-system-deps)."
  command -v curl >/dev/null 2>&1 || { pkg_install curl || die "curl is required to download Node.js."; }
  local os arch sums fname from_sums=0 base url tmp
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in Linux) os="linux";; Darwin) os="darwin";; *) die "Unsupported OS for automatic Node.js install: $os" ;; esac
  case "$arch" in x86_64) arch="x64";; aarch64|arm64) arch="arm64";; armv7l) arch="armv7l";; *) die "Unsupported CPU for automatic Node.js install: $arch" ;; esac
  base="https://nodejs.org/dist/latest-v22.x/"
  tmp="$(mktemp -d)"
  if sums="$(curl -fsSL --max-time 30 "$base/SHASUMS256.txt")"; then
    fname="$(printf '%s\n' "$sums" | awk -v pat="node-v22.*-${os}-${arch}[.]tar[.]gz$" '$2 ~ pat {print $2; exit}')"
    [ -n "$fname" ] && from_sums=1
  fi
  if [ -z "${fname:-}" ]; then
    fname="node-v22.14.0-${os}-${arch}.tar.gz" # pinned, known-good fallback
    base="https://nodejs.org/dist/v22.14.0/"
  fi
  url="${base}${fname}"
  say "Downloading Node.js (${fname}) ..."
  curl -fsSL --retry 3 -o "$tmp/$fname" "$url" || die "Node.js download failed."
  if [ "$from_sums" -eq 1 ] && command -v sha256sum >/dev/null 2>&1; then
    (cd "$tmp" && printf '%s\n' "$sums" | grep -F " $fname" | sha256sum -c -) \
      || die "Node.js checksum verification failed."
  fi
  say "Installing Node.js to /usr/local ..."
  tar -xzf "$tmp/$fname" -C "$tmp" || die "Node.js archive extraction failed."
  local dir
  dir="$(find "$tmp" -maxdepth 1 -type d -name 'node-v*' | head -1)"
  run_root cp -a "$dir/bin" "$dir/include" "$dir/lib" "$dir/share" /usr/local/ \
    || die "Node.js install failed (need root or sudo)."
  rm -rf "$tmp"; hash -r 2>/dev/null || true
  node_ok || die "Node.js install did not yield node 22+ on PATH."
}

# C++ toolchain for native modules (argon2, better-sqlite3), on demand only.
install_build_toolchain() {
  [ "$ON_WINDOWS" -eq 1 ] && return 1
  [ "$SYS_DEPS" -eq 0 ] && return 1
  detect_pkg_mgr || return 1
  say "Installing C++ build tools for native modules ..."
  case "$PKG_MGR" in
    apt) pkg_install build-essential python3 ;;
    dnf|yum) pkg_install gcc-c++ make python3 ;;
    pacman) pkg_install base-devel python ;;
    zypper) pkg_install gcc-c++ make python3 ;;
    apk) pkg_install build-base python3 ;;
    *) return 1 ;;
  esac
}

ensure_base_tools

# If we are not inside a checkout (e.g. `curl ... | bash`), clone and re-exec.
if [ ! -f "server/package.json" ] || [ ! -f "frontend/package.json" ]; then
  [ -n "${KCT_BOOTSTRAPPED:-}" ] && die "Could not find a KineticCT checkout after cloning."
  say "Cloning KineticCT into ${INSTALL_DIR} ..."
  command -v git >/dev/null 2>&1 || die "git is required for automatic setup. Install git and re-run."
  if [ -d "$INSTALL_DIR" ]; then
    warn "Directory exists, reusing: $INSTALL_DIR"
  else
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" \
      || die "Clone failed. Check the URL and your network connection."
  fi
  export KCT_BOOTSTRAPPED=1
  # Forward flags safely (positional params handle paths with spaces).
  set -- --dir="$INSTALL_DIR"
  [ "$YES" -eq 1 ] && set -- "$@" --yes
  [ "$NON_INTERACTIVE" -eq 1 ] && set -- "$@" --non-interactive
  [ -n "${SERVICE:-}" ] && set -- "$@" --service="$SERVICE"
  [ "$NO_SERVICE" -eq 1 ] && set -- "$@" --no-service
  [ "$SYS_DEPS" -eq 0 ] && set -- "$@" --no-system-deps
  [ "$START_NOW" -eq 1 ] && set -- "$@" --start
  exec bash "$INSTALL_DIR/install.sh" "$@"
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# prerequisites
# ---------------------------------------------------------------------------
say "Checking system dependencies ..."
if ! node_ok; then
  if [ "$ON_WINDOWS" -eq 1 ]; then
    die "Node.js 22+ is required. Install it from https://nodejs.org and re-run."
  fi
  install_nodejs
fi
command -v node >/dev/null 2>&1 || die "Node.js is not installed."
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22+ is required (found $(node -v))."
command -v npm >/dev/null 2>&1 || die "npm was not found alongside Node.js."
info "node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------------------
# questions
# ---------------------------------------------------------------------------
ask() {
  # ask VAR "Prompt" "default" — result lands in $VAR (env wins, then default).
  local var="$1" prompt="$2" default="${3:-}" answer=""
  if [ -n "${!var:-}" ]; then return 0; fi
  if [ "$NON_INTERACTIVE" -eq 1 ] && [ -z "$default" ]; then
    die "$var is required in --non-interactive mode (export $var first)."
  fi
  if [ "$YES" -eq 1 ]; then printf -v "$var" '%s' "$default"; return 0; fi
  printf '  %s' "$prompt"
  [ -n "$default" ] && printf ' [%s]' "$default"
  printf ': '
  IFS= read -r answer <"$TTY_IN" || answer=""
  [ -z "$answer" ] && answer="$default"
  printf -v "$var" '%s' "$answer"
}

ask_yes_no() {
  # ask_yes_no VAR "Prompt" "y|n" — result is 1/0.
  local var="$1" prompt="$2" default="${3:-y}" answer=""
  if [ -n "${!var:-}" ]; then
    case "${!var}" in y|Y|1|true) printf -v "$var" '%s' "1";; *) printf -v "$var" '%s' "0";; esac
    return 0
  fi
  if [ "$YES" -eq 1 ]; then
    [ "$default" = "y" ] && printf -v "$var" '%s' "1" || printf -v "$var" '%s' "0"
    return 0
  fi
  printf '  %s [%s]: ' "$prompt" "$default"
  IFS= read -r answer <"$TTY_IN" || answer=""
  [ -z "$answer" ] && answer="$default"
  case "$answer" in y|Y|yes|YES) printf -v "$var" '%s' "1";; *) printf -v "$var" '%s' "0";; esac
}

gen_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 18 | tr -d '\n'
  else
    head -c 24 /dev/urandom | base64 | tr -d '\n' | cut -c1-24
  fi
}

say "Configuration (press Enter to accept each default) ..."
ask PORT "Port to listen on" "8080"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] \
  || die "PORT must be a number between 1 and 65535."

ask VITE_API_BASE_URL "Public API base URL seen by the browser (empty = same server, recommended)" ""
ask DATABASE_PATH "SQLite database file" "$REPO_ROOT/data/kineticct.sqlite"
ask NODE_ENV "Environment (production/development)" "production"
[ "$NODE_ENV" = "production" ] || [ "$NODE_ENV" = "development" ] \
  || die "NODE_ENV must be 'production' or 'development'."
ask SESSION_TTL_HOURS "Session lifetime in hours (1-720)" "168"
ask LOGIN_RATE_LIMIT_MAX "Max login attempts per 15 min per IP" "20"
ask SEED_ADMIN_NAME "Initial administrator display name" "Administrator"

while :; do
  ask SEED_ADMIN_EMAIL "Initial administrator email (required)" ""
  if [[ "$SEED_ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then break; fi
  [ "$NON_INTERACTIVE" -eq 1 ] && die "SEED_ADMIN_EMAIL is not a valid email address."
  [ "$YES" -eq 1 ] && [ -z "$SEED_ADMIN_EMAIL" ] && die "Set SEED_ADMIN_EMAIL in the environment when using --yes."
  warn "That does not look like an email address, try again."
  SEED_ADMIN_EMAIL=""
done

GENERATED_PASSWORD=0
if [ -z "${SEED_ADMIN_PASSWORD:-}" ]; then
  if [ "$YES" -eq 1 ]; then
    SEED_ADMIN_PASSWORD="$(gen_password)"
    GENERATED_PASSWORD=1
  else
    printf '  Initial admin password (empty = generate a strong one): '
    IFS= read -r -s SEED_ADMIN_PASSWORD <"$TTY_IN" || SEED_ADMIN_PASSWORD=""
    printf '\n'
    if [ -z "$SEED_ADMIN_PASSWORD" ]; then
      SEED_ADMIN_PASSWORD="$(gen_password)"
      GENERATED_PASSWORD=1
    fi
  fi
fi
[ "${#SEED_ADMIN_PASSWORD}" -ge 10 ] || die "Admin password must be at least 10 characters."
export SEED_ADMIN_PASSWORD

ask SESSION_COOKIE_NAME "Session cookie name" "kct_session"
ask CORS_ORIGINS "Extra allowed browser origins, comma-separated (empty = same-origin only)" ""

SERVICE="$(printf '%s' "${SERVICE:-}" | tr '[:upper:]' '[:lower:]')"
if [ "$NO_SERVICE" -eq 1 ]; then SERVICE="none"; fi
if [ -z "$SERVICE" ]; then
  if [ "$YES" -eq 1 ]; then
    SERVICE="pm2"
  else
    svc_answer=""
    printf '  Run in the background and on boot via [1] PM2 (recommended), [2] systemd, [3] no autostart [1]: '
    IFS= read -r svc_answer <"$TTY_IN" || svc_answer=""
    case "$svc_answer" in
      2|systemd) SERVICE="systemd" ;;
      3|none|no) SERVICE="none" ;;
      *) SERVICE="pm2" ;;
    esac
  fi
fi
case "$SERVICE" in
  pm2|systemd|none) ;;
  *) die "Invalid --service value: $SERVICE (use pm2, systemd, or none)." ;;
esac
if [ "$SERVICE" = "systemd" ] && ! command -v systemctl >/dev/null 2>&1; then
  warn "systemctl not found — falling back to PM2."
  SERVICE="pm2"
fi

# ---------------------------------------------------------------------------
# write .env
# ---------------------------------------------------------------------------
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  BACKUP="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  warn "Backing up existing .env to $BACKUP"
  cp "$ENV_FILE" "$BACKUP"
fi

say "Writing $ENV_FILE ..."
cat > "$ENV_FILE" <<EOF
# Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep secret.
PORT=$PORT
VITE_API_BASE_URL=$VITE_API_BASE_URL
DATABASE_PATH=$DATABASE_PATH
SESSION_COOKIE_NAME=$SESSION_COOKIE_NAME
SESSION_TTL_HOURS=$SESSION_TTL_HOURS
NODE_ENV=$NODE_ENV
SEED_ADMIN_EMAIL=$SEED_ADMIN_EMAIL
SEED_ADMIN_PASSWORD=$SEED_ADMIN_PASSWORD
SEED_ADMIN_NAME=$SEED_ADMIN_NAME
CORS_ORIGINS=$CORS_ORIGINS
LOGIN_RATE_LIMIT_MAX=$LOGIN_RATE_LIMIT_MAX
EOF
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------------------
# install + build
# ---------------------------------------------------------------------------
say "Installing project dependencies (frontend + backend) ..."
cd "$REPO_ROOT"
if ! npm install --no-audit --no-fund; then
  warn "npm install failed — retrying with the C++ build toolchain installed ..."
  if install_build_toolchain && npm install --no-audit --no-fund; then
    info "Install succeeded after adding build tools."
  else
    die "npm install failed."
  fi
fi
# Native modules (argon2, better-sqlite3) need install-script approval on npm 11+.
if npm approve-scripts --help >/dev/null 2>&1; then
  npm approve-scripts argon2 better-sqlite3 esbuild >/dev/null 2>&1 || true
  npm rebuild argon2 better-sqlite3 >/dev/null 2>&1 || true
fi

say "Building frontend (API URL: ${VITE_API_BASE_URL:-same-origin}) ..."
export VITE_API_BASE_URL
npm run build --workspace=frontend || die "Frontend build failed."

say "Building backend ..."
npm run build --workspace=server || die "Backend build failed."

say "Applying database migrations ..."
npm run migrate --workspace=server || die "Migrations failed."
info "Database ready at $DATABASE_PATH"

# ---------------------------------------------------------------------------
# background service: PM2 (default) or systemd
# ---------------------------------------------------------------------------
SERVICE_USER="${SUDO_USER:-${USER:-$(id -un)}}"

# Run a command as the service user (handles sudo-wrapped installs where the
# PM2 daemon must belong to the original user, not root).
as_user() {
  if [ "$(id -u)" -eq 0 ] && [ "$SERVICE_USER" != "root" ]; then
    sudo -Hu "$SERVICE_USER" env PATH="$PATH" "$@"
  else
    "$@"
  fi
}

ensure_pm2() {
  command -v pm2 >/dev/null 2>&1 && return 0
  say "Installing PM2 (process manager) ..."
  if npm install -g pm2 --no-audit --no-fund >/dev/null 2>&1; then return 0; fi
  if command -v sudo >/dev/null 2>&1 && sudo npm install -g pm2 --no-audit --no-fund >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

install_pm2_service() {
  ensure_pm2 || die "PM2 could not be installed. Re-run with --service systemd or --service none."
  info "pm2 $(as_user pm2 --version)"
  say "Starting KineticCT under PM2 ..."
  as_user pm2 delete kineticct >/dev/null 2>&1 || true
  as_user pm2 start "$REPO_ROOT/server/dist/index.js" --name kineticct \
    --cwd "$REPO_ROOT/server" --update-env || die "pm2 start failed."
  # Persist the process list, then hook PM2 into the boot sequence.
  as_user pm2 save --force >/dev/null
  say "Enabling PM2 on boot ..."
  startup_out="$(if command -v timeout >/dev/null 2>&1; then timeout 60 as_user pm2 startup 2>&1; else as_user pm2 startup 2>&1; fi)" || startup_out=""
  hook="$(printf '%s' "$startup_out" | grep -E 'pm2 startup (systemd|launchd|openrc|systemv)' | tail -n 1 | sed 's/^[[:space:]]*//')" || hook=""
  if [ -z "$hook" ]; then
    warn "Could not detect the boot hook (unsupported init or already configured)."
    warn "Run manually if needed: pm2 startup && pm2 save"
  else
    if [ "$(id -u)" -eq 0 ]; then
      hook="${hook#sudo }" # already root; sudo may not exist
    elif [[ "$hook" != sudo* ]] && command -v sudo >/dev/null 2>&1; then
      hook="sudo $hook"
    fi
    if bash -c "$hook" >/dev/null 2>&1; then
      info "Boot hook installed."
    else
      warn "Boot hook failed — run manually: $hook"
    fi
    as_user pm2 save --force >/dev/null
  fi
  sleep 2
  if [ -n "$(as_user pm2 pid kineticct 2>/dev/null)" ]; then
    info "KineticCT is running under PM2."
  else
    warn "PM2 process is not online — check: pm2 logs kineticct"
  fi
  # Honest health check against the real API.
  if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    info "Health check passed."
  else
    warn "Health check did not pass yet — check: pm2 logs kineticct"
  fi
}

# ---------------------------------------------------------------------------
# service (optional)
# ---------------------------------------------------------------------------
case "$SERVICE" in
pm2)
  install_pm2_service
  ;;
systemd)
  say "Installing systemd service ..."
  NODE_BIN="$(command -v node)"
  UNIT="[Unit]
Description=KineticCT LXC management panel
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_ROOT}/server
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
"
  if [ "$(id -u)" -eq 0 ]; then
    printf '%s' "$UNIT" > /etc/systemd/system/kineticct.service
    systemctl daemon-reload
    systemctl enable --now kineticct.service
  elif command -v sudo >/dev/null 2>&1; then
    printf '%s' "$UNIT" | sudo tee /etc/systemd/system/kineticct.service >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable --now kineticct.service
  else
    die "Cannot install the service: not root and sudo is unavailable."
  fi
  sleep 3
  if systemctl is-active --quiet kineticct.service; then
    info "Service is running."
  else
    warn "Service installed but not active — check: journalctl -u kineticct -e"
  fi
  ;;
none)
  ;;
esac

# ---------------------------------------------------------------------------
# done
# ---------------------------------------------------------------------------
BASE_URL="http://127.0.0.1:${PORT}"
say "KineticCT is installed."
info "Directory:  $REPO_ROOT"
info "URL:        $BASE_URL"
info "Admin login: $SEED_ADMIN_EMAIL"
if [ "$GENERATED_PASSWORD" -eq 1 ]; then
  info "Admin password (generated, change it after first login):"
  printf '\n  %s\n\n' "$SEED_ADMIN_PASSWORD"
else
  info "Admin password: the one you entered (change it after first login)."
fi
if [ "$SERVICE" = "pm2" ]; then
  info "Manage with: pm2 [logs|restart|stop|monit] kineticct  (persist changes with: pm2 save)"
elif [ "$SERVICE" = "systemd" ]; then
  info "Service: sudo systemctl [status|restart|stop] kineticct | logs: journalctl -u kineticct -e"
fi
if [ "$START_NOW" -eq 1 ] && [ "$SERVICE" = "none" ]; then
  say "Starting the server (Ctrl+C to stop) ..."
  cd "$REPO_ROOT/server" && exec node dist/index.js
elif [ "$SERVICE" = "none" ]; then
  info "Start it with:  cd $REPO_ROOT/server && node dist/index.js"
  info "   (or re-run with --start, or pick --service pm2|systemd)"
fi
