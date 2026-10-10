#!/usr/bin/env bash
#
# KineticCT — one-command updater for an existing install.
#
#   curl -fsSL https://raw.githubusercontent.com/xAyan55/KineticContainers/main/update.sh | bash
#
# What it does: pulls latest main, reinstalls deps, rebuilds frontend +
# backend, migrates the DB, and restarts the PM2 process (preserving .env
# and data/). Set KCT_DIR if your checkout lives elsewhere.
#
set -euo pipefail

# This script never reads stdin (it is usually piped via curl) and must never
# wait on an interactive prompt — fail fast with an error instead of hanging.
exec </dev/null
export GIT_TERMINAL_PROMPT=0
export DEBIAN_FRONTEND=noninteractive
export NPM_CONFIG_UPDATE_NOTIFIER=false

DIR="${KCT_DIR:-/root/KineticContainers}"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  ✕ %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$DIR/.git" ] || die "No checkout at $DIR (set KCT_DIR, or install fresh with install.sh)."
cd "$DIR" || die "Cannot enter $DIR."
[ -f ".env" ] || die "No .env in $DIR — run install.sh first."

say "Updating KineticCT in $DIR ..."
git fetch origin main || die "git fetch failed."
git reset --hard origin/main || die "git reset failed."

# Frontend bakes the API URL in at build time — reuse the installed value.
export VITE_API_BASE_URL="$(grep -E '^VITE_API_BASE_URL=' .env | cut -d= -f2-)"
PORT="$(grep -E '^PORT=' .env | cut -d= -f2-)"
PORT="${PORT:-8080}"

say "Installing dependencies ..."
if ! npm install --no-audit --no-fund; then
  warn "npm install failed — installing C++ build tools and retrying ..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential python3
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q gcc-c++ make python3
  fi
  npm install --no-audit --no-fund || die "npm install failed."
fi
if npm approve-scripts --help >/dev/null 2>&1; then
  npm approve-scripts argon2 better-sqlite3 esbuild node-pty >/dev/null 2>&1 || true
  npm rebuild argon2 better-sqlite3 node-pty >/dev/null 2>&1 || true
fi

# The console tab needs the node-pty native binding. Verify it actually loads.
# npm will not retry a previously skipped optional dependency on its own, so
# a missing/broken directory must be cleared and explicitly reinstalled.
check_pty() {
  (cd "$DIR/server" && node -e "require('node-pty')" >/dev/null 2>&1)
}

if ! check_pty; then
  warn "node-pty binding not usable — installing build tools and (re)installing ..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential python3 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q gcc-c++ make python3 || true
  fi
  rm -rf "$DIR/server/node_modules/node-pty"
  npm install --no-save --workspace=server node-pty --no-audit --no-fund >/dev/null 2>&1 || true
  npm rebuild node-pty >/dev/null 2>&1 || true
  if check_pty; then
    info "node-pty binding repaired."
  else
    warn "node-pty still unavailable — the console tab will report unsupported until it builds."
  fi
fi

say "Rebuilding ..."
export VITE_API_BASE_URL
npm run build --workspace=frontend || die "Frontend build failed."
npm run build --workspace=server || die "Backend build failed."

say "Migrating database ..."
npm run migrate --workspace=server || die "Migrations failed."

command -v pm2 >/dev/null 2>&1 || npm install -g pm2 --no-audit --no-fund || die "PM2 is missing and could not be installed."
say "Restarting panel ..."
pm2 restart kineticct --update-env >/dev/null 2>&1 \
  || pm2 start "$DIR/server/dist/index.js" --name kineticct --cwd "$DIR/server" --update-env \
  || die "Could not (re)start the panel under PM2."
pm2 save --force >/dev/null 2>&1 || true

sleep 3
if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  say "Updated and healthy: http://127.0.0.1:${PORT}/api/health"
else
  warn "Restarted, but the health check did not pass — see: pm2 logs kineticct"
fi
