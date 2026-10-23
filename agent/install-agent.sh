#!/usr/bin/env bash
#
# KineticCT Remote Node Agent — Standalone Installer
#
# Installs and configures the remote LXC node agent on a Linux server/VPS,
# including NAT VPS setups reachable via Cloudflare Tunnel.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xAyan55/KineticContainers/main/agent/install-agent.sh | sudo bash -s -- [options]
#
# Options:
#   --node-id ID          Node identifier assigned by KineticCT controller.
#   --token TOKEN         Secure node authentication credential.
#   --port PORT           Local listen port (default: 5433).
#   --listen IP           Local bind IP (default: 127.0.0.1).
#   --dir DIR             Agent installation directory (default: /opt/kineticct-agent).
#   --skip-lxc            Skip LXC and system package installation.
#   -y, --yes             Accept defaults non-interactively.
#   -h, --help            Show this help message.
#
set -euo pipefail

NODE_ID="${NODE_ID:-}"
TOKEN="${TOKEN:-}"
LISTEN_IP="${LISTEN_IP:-127.0.0.1}"
LISTEN_PORT="${LISTEN_PORT:-5433}"
INSTALL_DIR="${INSTALL_DIR:-/opt/kineticct-agent}"
CONFIG_DIR="/etc/kineticct"
CONFIG_FILE="${CONFIG_DIR}/agent.json"
SKIP_LXC=0
YES=0

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  ✕ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --node-id) NODE_ID="$2"; shift 2 ;;
    --node-id=*) NODE_ID="${1#--node-id=}"; shift ;;
    --token) TOKEN="$2"; shift 2 ;;
    --token=*) TOKEN="${1#--token=}"; shift ;;
    --port) LISTEN_PORT="$2"; shift 2 ;;
    --port=*) LISTEN_PORT="${1#--port=}"; shift ;;
    --listen) LISTEN_IP="$2"; shift 2 ;;
    --listen=*) LISTEN_IP="${1#--listen=}"; shift ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#--dir=}"; shift ;;
    --skip-lxc) SKIP_LXC=1; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  die "This installer must be run as root (or via sudo)."
fi

say "============================================================"
say " KineticCT Remote Node Agent Installer"
say "============================================================"

# 1. System package management & LXC setup
if [ "$SKIP_LXC" -eq 0 ]; then
  say "1. Installing required host tools and LXC packages..."
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq lxc lxc-templates debootstrap bridge-utils uidmap openssl curl git lxcfs build-essential python3 make g++
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q lxc lxc-templates debootstrap bridge-utils openssl curl git lxcfs gcc-c++ make python3 || true
  elif command -v apk >/dev/null 2>&1; then
    apk add --quiet lxc lxc-templates debootstrap bridge-utils openssl curl git lxcfs || true
  else
    warn "Unsupported package manager. Please ensure LXC, bridge-utils, and openssl are installed."
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now lxcfs >/dev/null 2>&1 || true
  fi
fi

# 2. Node.js check (require Node 20+)
say "2. Checking Node.js runtime..."
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ]; then
    NODE_OK=1
  fi
fi

if [ "$NODE_OK" -eq 0 ]; then
  info "Installing Node.js 22 LTS..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    dnf install -y -q nodejs
  elif command -v apk >/dev/null 2>&1; then
    apk add --quiet nodejs npm
  else
    die "Node.js 20+ is required but could not be installed automatically. Please install Node.js."
  fi
fi
info "Using Node $(node -v) at $(command -v node)"

# 3. Setup Agent Directory
say "3. Setting up agent application in ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
# If running from local git checkout, copy files; otherwise clone/fetch
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
fi

if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/package.json" ]; then
  cp -r "${SCRIPT_DIR}/"* "${INSTALL_DIR}/"
else
  TMP_CLONE=$(mktemp -d)
  git clone --depth 1 https://github.com/xAyan55/KineticContainers.git "${TMP_CLONE}"
  cp -r "${TMP_CLONE}/agent/"* "${INSTALL_DIR}/"
  rm -rf "${TMP_CLONE}"
fi

cd "${INSTALL_DIR}"
npm install --silent
npm run build

# 4. Generate TLS Certificates
say "4. Generating local self-signed TLS certificates..."
mkdir -p "${CONFIG_DIR}"
chmod 700 "${CONFIG_DIR}"
CERT_FILE="${CONFIG_DIR}/cert.pem"
KEY_FILE="${CONFIG_DIR}/key.pem"

if [ ! -f "${CERT_FILE}" ] || [ ! -f "${KEY_FILE}" ]; then
  openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" \
    -days 3650 -nodes -subj "/CN=KineticCT-Node-Agent" >/dev/null 2>&1
  chmod 600 "${KEY_FILE}"
  chmod 644 "${CERT_FILE}"
  info "TLS certificate generated at ${CERT_FILE}"
fi

# 5. Configure agent.json
say "5. Configuring ${CONFIG_FILE}..."
if [ -z "${NODE_ID}" ] && [ -f "${CONFIG_FILE}" ]; then
  NODE_ID=$(grep -o '"nodeId": *"[^"]*"' "${CONFIG_FILE}" | cut -d'"' -f4 || true)
fi
if [ -z "${TOKEN}" ] && [ -f "${CONFIG_FILE}" ]; then
  TOKEN=$(grep -o '"authToken": *"[^"]*"' "${CONFIG_FILE}" | cut -d'"' -f4 || true)
fi

cat > "${CONFIG_FILE}" <<EOF
{
  "nodeId": "${NODE_ID}",
  "authToken": "${TOKEN}",
  "listenHost": "${LISTEN_IP}",
  "listenPort": ${LISTEN_PORT},
  "certPath": "${CERT_FILE}",
  "keyPath": "${KEY_FILE}",
  "lxcPath": "/var/lib/lxc"
}
EOF
chmod 600 "${CONFIG_FILE}"

# 6. Setup and start systemd service
if command -v systemctl >/dev/null 2>&1 && systemctl status >/dev/null 2>&1; then
  say "6. Configuring systemd service..."
  cp "${INSTALL_DIR}/kineticct-agent.service" /etc/systemd/system/kineticct-agent.service
  systemctl daemon-reload
  systemctl enable kineticct-agent.service
  systemctl restart kineticct-agent.service
  info "KineticCT Remote Node Agent service started via systemd."
else
  warn "systemd not available. You can start the agent manually with:"
  info "cd ${INSTALL_DIR} && node dist/index.js --config ${CONFIG_FILE}"
fi

say ""
say "============================================================"
say " KineticCT Remote Node Agent installed successfully!"
say "============================================================"
info "Agent listener: https://${LISTEN_IP}:${LISTEN_PORT} (HTTPS)"
info "Node ID:        ${NODE_ID:-<not enrolled yet>}"
info "Config:         ${CONFIG_FILE}"
say ""
say "Next steps for NAT VPS & Cloudflare Tunnel:"
say "  1. Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/"
say "  2. Configure tunnel ingress in /etc/cloudflared/config.yml:"
say "       ingress:"
say "         - hostname: <your-node-hostname.example.com>"
say "           service: https://localhost:${LISTEN_PORT}"
say "           originRequest:"
say "             noTLSVerify: true"
say "         - service: http_status:404"
say "  3. Start the tunnel: cloudflared tunnel run <tunnel-name>"
say "  4. In KineticCT Admin Panel -> Nodes -> Add Node:"
say "       Public HTTPS URL: https://<your-node-hostname.example.com>"
say "       Node ID:          ${NODE_ID}"
say "       Token:            ${TOKEN}"
say "       Click 'Test Connection & Verify'"
say "============================================================"
