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
#       --skip-lxc        Skip automatic LXC host setup (panel only).
#       --setup-lxc-only  Only configure LXC on this host for an EXISTING
#                         installation. Never touches .env, the database,
#                         users, or service config. Requires root.
#       --repair          Repair drift on EXISTING managed VPS (re-apply
#                         limits, LXCFS include, btrfs quotas). Never touches
#                         .env, users, settings, ports, or service config.
#       --probe           Run a full create/start/stop/destroy probe container
#                         during verification (default in --setup-lxc-only).
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
  SKIP_LXC=0
  SETUP_LXC_ONLY=0
  REPAIR=0
  PROBE=0
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
    --skip-lxc) SKIP_LXC=1; shift ;;
    --setup-lxc-only) SETUP_LXC_ONLY=1; shift ;;
    --repair) REPAIR=1; shift ;;
    --probe) PROBE=1; shift ;;
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

# ---------------------------------------------------------------------------
# LXC host setup (packages, permissions, networking, verification)
# ---------------------------------------------------------------------------
# Status globals (never unset; safe under `set -u`).
LXC_STATUS="pending"
LXC_DETAIL=""
LXC_PACKAGES="pending"
LXC_NET="pending"
LXC_PROBE="pending"
LXC_OS_ID=""
LXC_OS_LIKE=""
LXC_ARCH=""
LXC_GUEST=""
LXC_RESTRICTED=0
LXC_USERNS="unknown"
LXC_CGROUP="none"
LXC_BRIDGE="absent"
LXC_IPFWD="unknown"
LXC_HAS_LXC=0
LXCFS_STATUS="pending"
LXCFS_DETAIL=""
LXCFS_CONTAINER="pending"
KCT_NODE_STATUS="unknown"
KCT_NODE_DETAIL=""

lxc_runtime_user() {
  if [ -n "${SUDO_USER:-}" ]; then printf '%s' "$SUDO_USER"; return 0; fi
  if [ -n "${USER:-}" ]; then printf '%s' "$USER"; return 0; fi
  id -un 2>/dev/null || printf 'root'
}

# $1 = die|warn. Root (or working sudo) is mandatory for host changes.
require_lxc_root() {
  if [ "$(id -u)" -eq 0 ]; then return 0; fi
  if command -v sudo >/dev/null 2>&1; then
    if sudo true 2>/dev/null; then return 0; fi
  fi
  if [ "$1" = "die" ]; then
    die "LXC setup needs root privileges (run as root or with working sudo)."
  fi
  warn "LXC setup needs root privileges — continuing without LXC."
  return 1
}

# Keep a single backup; never overwrite it, never touch anything else.
backup_file() { # $1 = file
  local f="$1"
  if [ ! -f "$f" ]; then return 0; fi
  if [ -f "$f.kct-bak" ]; then return 0; fi
  if run_root cp -a "$f" "$f.kct-bak"; then return 0; fi
  return 1
}

ensure_subid() { # $1 = user, $2 = /etc/subuid or /etc/subgid
  local user="$1" file="$2"
  if [ ! -f "$file" ]; then
    if ! run_root touch "$file"; then return 1; fi
    run_root chmod 644 "$file" || true
  fi
  if grep -qE "^${user}:" "$file" 2>/dev/null; then return 0; fi
  if ! backup_file "$file"; then return 1; fi
  if printf '%s:100000:65536\n' "$user" | run_root tee -a "$file" >/dev/null; then return 0; fi
  return 1
}

lxc_detect_all() {
  LXC_OS_ID="$(kct_os_id)"
  LXC_OS_LIKE="$(kct_os_like)"
  LXC_ARCH="$(uname -m 2>/dev/null || printf 'unknown')"
  LXC_GUEST="$(kct_detect_guest)"
  if kct_restricted_guest "$LXC_GUEST"; then LXC_RESTRICTED=1; else LXC_RESTRICTED=0; fi
  LXC_USERNS="$(kct_userns)"
  LXC_CGROUP="$(kct_cgroup)"
  LXC_BRIDGE="$(kct_bridge lxcbr0)"
  LXC_IPFWD="$(kct_ipfwd)"
  if command -v lxc-ls >/dev/null 2>&1; then LXC_HAS_LXC=1; else LXC_HAS_LXC=0; fi
}

setup_lxc_packages() {
  if ! detect_pkg_mgr; then
    warn "No supported package manager found."
    return 1
  fi
  local pkgs
  pkgs="$(kct_lxc_packages "$PKG_MGR")"
  if [ -z "$pkgs" ]; then
    warn "Automatic LXC install supports Debian/Ubuntu (apt) only."
    return 1
  fi
  # shellcheck disable=SC2086 — intentional word splitting of the package list.
  if pkg_install $pkgs; then
    hash -r 2>/dev/null || true
    if command -v lxc-ls >/dev/null 2>&1; then
      LXC_PACKAGES="installed"
      return 0
    fi
    warn "Packages installed but lxc-ls is still missing."
    return 1
  fi
  warn "Package installation failed."
  return 1
}

setup_lxc_network() {
  LXC_NET="unverified"
  if [ "$(kct_bridge lxcbr0)" = "present" ]; then
    info "Container bridge lxcbr0 already present — leaving host networking untouched."
    LXC_NET="ok"
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "No systemd here: cannot manage lxc-net; container networking stays unverified."
    return 1
  fi
  if [ ! -f /lib/systemd/system/lxc-net.service ] && [ ! -f /etc/systemd/system/lxc-net.service ]; then
    warn "lxc-net unit not found; container networking stays unverified."
    return 1
  fi
  if ! run_root systemctl enable --now lxc-net >/dev/null 2>&1; then
    warn "Could not start lxc-net."
    return 1
  fi
  sleep 2
  if [ "$(kct_bridge lxcbr0)" = "present" ]; then
    info "Bridge lxcbr0 is up via lxc-net."
    if [ "$(kct_ipfwd)" != "1" ]; then
      if printf 'net.ipv4.ip_forward=1\n' | run_root tee /etc/sysctl.d/99-kineticct-lxc.conf >/dev/null 2>&1; then
        run_root sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
        info "Enabled IPv4 forwarding for the container bridge (drop-in file only; firewall untouched)."
      else
        warn "Could not enable IPv4 forwarding."
      fi
    fi
    LXC_NET="ok"
    return 0
  fi
  warn "lxc-net started but lxcbr0 did not appear."
  return 1
}

# LXCFS gives containers correct /proc/meminfo, /proc/cpuinfo, /proc/stat,
# /proc/uptime, /proc/swaps and /sys/devices/system/cpu/online views.
# Best effort: a missing/broken LXCFS never fails the whole setup, it is
# reported as unverified with the reason.
setup_lxcfs() {
  LXCFS_STATUS="unverified"
  if ! command -v lxcfs >/dev/null 2>&1; then
    if [ "${PKG_MGR:-}" = "apt" ] || { detect_pkg_mgr && [ "$PKG_MGR" = "apt" ]; }; then
      info "Installing the lxcfs package for container-aware resource views ..."
      if ! pkg_install lxcfs; then
        LXCFS_DETAIL="lxcfs package installation failed"
        warn "${LXCFS_DETAIL}."
        return 1
      fi
      hash -r 2>/dev/null || true
    else
      LXCFS_DETAIL="lxcfs not installed and no supported package manager to install it (needs the 'lxcfs' package)"
      warn "${LXCFS_DETAIL}."
      return 1
    fi
  fi
  if command -v systemctl >/dev/null 2>&1; then
    if [ -f /lib/systemd/system/lxcfs.service ] || [ -f /etc/systemd/system/lxcfs.service ]; then
      if ! run_root systemctl enable --now lxcfs >/dev/null 2>&1; then
        warn "Could not start the lxcfs service."
      fi
      sleep 2
    else
      warn "lxcfs installed but no systemd unit found; cannot ensure it runs."
    fi
  else
    warn "No systemd here; cannot ensure the lxcfs daemon runs."
  fi
  if ! kct_lxcfs_serving; then
    LXCFS_DETAIL="lxcfs FUSE view is not mounted/serving (/var/lib/lxcfs)"
    warn "${LXCFS_DETAIL}."
    return 1
  fi
  if ! kct_lxcfs_include_present; then
    LXCFS_DETAIL="lxcfs serves, but the distro integration file is missing (/usr/share/lxc/config/common.conf.d/00-lxcfs.conf)"
    warn "${LXCFS_DETAIL}."
    return 1
  fi
  LXCFS_STATUS="ok"
  LXC_EVIDENCE="${LXC_EVIDENCE}lxcfs: serving, integration file present$(printf '\n')"
  info "LXCFS is serving container-aware resource views."
  return 0
}

# KineticCT uses classic LXC (lxc-ls, lxc-create, ...). There is intentionally
# NO `lxc` binary: `lxc list` is LXD/Incus syntax and its absence proves
# nothing about this setup. Every binary below is checked by name; the core
# tools additionally have to execute `--version`, and `lxc-ls -f` must really
# list. Anything less is a hard failure, never a silent success.
LXC_REQUIRED_BINS="lxc-ls lxc-info lxc-create lxc-start lxc-stop lxc-destroy lxc-attach lxc-cgroup lxc-wait"
LXC_VERSION_BINS="lxc-ls lxc-info lxc-create lxc-start lxc-stop lxc-destroy"
LXC_EVIDENCE=""

# Basic capability proof: binaries present, core tools executable, download
# template present, inventory listable, storage path exists.
verify_lxc_basic() {
  local missing
  missing="$(kct_bins_missing $LXC_REQUIRED_BINS)"
  if [ -n "$missing" ]; then LXC_DETAIL="missing binaries:$(printf '%s' "$missing" | tr '\n' ' ')"; return 1; fi
  local b ver out
  for b in $LXC_VERSION_BINS; do
    if out="$("$b" --version 2>&1)"; then
      ver="$(printf '%s' "$out" | head -n 1)"
      LXC_EVIDENCE="${LXC_EVIDENCE}${b}: ${ver}$(printf '\n')"
    else
      warn "$b is present but would not execute --version."
      LXC_EVIDENCE="${LXC_EVIDENCE}${b}: present but --version failed$(printf '\n')"
    fi
  done
  if ! kct_template_present; then
    LXC_DETAIL="download template missing (/usr/share/lxc/templates/lxc-download)"
    return 1
  fi
  LXC_EVIDENCE="${LXC_EVIDENCE}template: /usr/share/lxc/templates/lxc-download present$(printf '\n')"
  local user
  user="$(lxc_runtime_user)"
  if [ "$(id -u)" -eq 0 ] && [ "$user" != "root" ]; then
    if command -v sudo >/dev/null 2>&1; then
      if ! sudo -Hu "$user" lxc-ls -f >/dev/null 2>&1; then
        LXC_DETAIL="runtime user '$user' cannot run lxc-ls"
        return 1
      fi
    else
      LXC_DETAIL="cannot verify LXC access for '$user' (no sudo)"
      return 1
    fi
  else
    if ! lxc-ls -f >/dev/null 2>&1; then
      LXC_DETAIL="lxc-ls failed — check permissions for '$user'"
      return 1
    fi
  fi
  if [ ! -d /var/lib/lxc ]; then LXC_DETAIL="/var/lib/lxc is missing"; return 1; fi
  return 0
}

# Full create/start/stop/destroy cycle on a uniquely-named temp container.
# Cleans up only what it created; never touches existing containers.
run_lxc_probe() {
  LXC_PROBE="failed"
  local name="kct-probe-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if lxc-ls 2>/dev/null | grep -qx "$name"; then
    LXC_DETAIL="probe name collision, retry the setup"
    return 1
  fi
  local create_args=(-n "$name" -t download -- -d ubuntu -r jammy -a amd64)
  if command -v timeout >/dev/null 2>&1; then
    if ! timeout 240 lxc-create "${create_args[@]}" >/dev/null 2>&1; then
      LXC_DETAIL="probe creation failed (image download needs working network/DNS)"
      lxc-destroy -f -n "$name" >/dev/null 2>&1 || true
      return 1
    fi
  else
    if ! lxc-create "${create_args[@]}" >/dev/null 2>&1; then
      LXC_DETAIL="probe creation failed (image download needs working network/DNS)"
      lxc-destroy -f -n "$name" >/dev/null 2>&1 || true
      return 1
    fi
  fi
  if ! lxc-start -n "$name" >/dev/null 2>&1; then
    LXC_DETAIL="probe container would not start"
    lxc-destroy -f -n "$name" >/dev/null 2>&1 || true
    return 1
  fi
  local i state="" probe_pid=""
  for i in $(seq 1 30); do
    state="$(lxc-info -n "$name" -sH 2>/dev/null || true)"
    if [ "$state" = "RUNNING" ]; then break; fi
    sleep 2
  done
  if [ "$state" != "RUNNING" ]; then
    LXC_DETAIL="probe container never reached RUNNING"
    lxc-destroy -f -n "$name" >/dev/null 2>&1 || true
    return 1
  fi
  # While it runs: verify LXCFS overlays are really mounted inside the guest.
  # Non-fatal — recorded separately from the create/start/stop/destroy result.
  LXCFS_CONTAINER="unverified"
  probe_pid="$(lxc-info -n "$name" -pH 2>/dev/null | grep -Eo '[0-9]+' | head -n 1 || true)"
  if [ -n "${probe_pid:-}" ] && [ -r "/proc/${probe_pid}/mountinfo" ]; then
    if grep -qE '(^|[[:space:]])lxcfs[[:space:]]' "/proc/${probe_pid}/mountinfo" 2>/dev/null; then
      LXCFS_CONTAINER="ok"
      info "Probe container has LXCFS overlays mounted."
    else
      warn "Probe container is missing LXCFS overlays (guest will see host resource info)."
    fi
  else
    warn "Could not inspect the probe container mounts."
  fi
  if ! lxc-stop -n "$name" >/dev/null 2>&1; then
    LXC_DETAIL="probe container would not stop cleanly"
    lxc-destroy -f -n "$name" >/dev/null 2>&1 || true
    return 1
  fi
  if ! lxc-destroy -n "$name" >/dev/null 2>&1; then
    LXC_DETAIL="probe cleanup (destroy) failed — remove '$name' manually"
    return 1
  fi
  LXC_PROBE="passed"
  return 0
}

# Shared core for fresh installs ("install") and existing hosts ("setup-only").
setup_lxc_host() { # $1 = install|setup-only
  local mode="$1"
  say "Setting up LXC host integration ..."
  lxc_detect_all
  info "OS: ${LXC_OS_ID:-unknown} (${LXC_ARCH}); guest: ${LXC_GUEST:-bare metal}; userns: ${LXC_USERNS}; cgroup: ${LXC_CGROUP}"
  if [ "$LXC_RESTRICTED" -eq 1 ]; then
    LXC_STATUS="unsupported"
    LXC_DETAIL="nested '${LXC_GUEST}' guest blocks nested LXC — move to a KVM VPS with nesting enabled by your provider"
    warn "Restricted environment (${LXC_GUEST}). ${LXC_DETAIL}."
    return 1
  fi
  case "$LXC_ARCH" in
    x86_64|aarch64) ;;
    *)
      LXC_STATUS="unsupported"
      LXC_DETAIL="unsupported CPU architecture ($LXC_ARCH)"
      warn "${LXC_DETAIL}."
      return 1
      ;;
  esac
  if [ "$LXC_HAS_LXC" -eq 1 ]; then
    info "LXC already installed — reusing the existing setup."
    LXC_PACKAGES="present"
  else
    if ! kct_distro_supported "$LXC_OS_ID" "$LXC_OS_LIKE"; then
      LXC_STATUS="unsupported"
      LXC_DETAIL="automatic LXC install supports Debian/Ubuntu only (found ${LXC_OS_ID:-unknown})"
      warn "${LXC_DETAIL}."
      return 1
    fi
    if ! setup_lxc_packages; then
      LXC_STATUS="failed"
      LXC_DETAIL="LXC package installation failed"
      return 1
    fi
  fi
  local ruser
  ruser="$(lxc_runtime_user)"
  if ! ensure_subid root /etc/subuid; then warn "Could not ensure /etc/subuid for root."; fi
  if ! ensure_subid root /etc/subgid; then warn "Could not ensure /etc/subgid for root."; fi
  if [ "$ruser" != "root" ]; then
    if ! ensure_subid "$ruser" /etc/subuid; then warn "Could not ensure /etc/subuid for $ruser."; fi
    if ! ensure_subid "$ruser" /etc/subgid; then warn "Could not ensure /etc/subgid for $ruser."; fi
  fi
  if ! setup_lxcfs; then
    info "Continuing without verified LXCFS views (guests will see host resource info)."
  fi
  if [ ! -f /etc/lxc/default.conf ]; then
    warn "No /etc/lxc/default.conf found; container creation may need explicit configuration."
  fi
  if ! setup_lxc_network; then
    info "Continuing without verified container networking."
  fi
  if ! verify_lxc_basic; then
    LXC_STATUS="failed"
    warn "LXC verification failed: ${LXC_DETAIL:-unknown reason}."
    return 1
  fi
  if [ "$ruser" != "root" ]; then
    LXC_STATUS="unverified"
    LXC_DETAIL="panel runs as '$ruser'; privileged container operations need a root service account"
    warn "${LXC_DETAIL}."
    return 1
  fi
  local want_probe=0
  if [ "$mode" = "setup-only" ]; then want_probe=1; fi
  if [ "$PROBE" -eq 1 ]; then want_probe=1; fi
  if [ "$want_probe" -eq 1 ]; then
    say "Running LXC capability probe (temporary container, cleaned up afterwards) ..."
    if run_lxc_probe; then
      info "Probe passed: create/start/stop/destroy all work."
    else
      LXC_STATUS="unverified"
      warn "Probe did not complete: ${LXC_DETAIL:-unknown reason}."
      return 1
    fi
  else
    LXC_PROBE="skipped"
  fi
  LXC_STATUS="ready"
  LXC_DETAIL="LXC installed, accessible, and verified"
  if [ "$LXC_NET" != "ok" ]; then
    LXC_DETAIL="LXC installed and accessible; container networking unverified"
  fi
  return 0
}

# Run the REAL backend health check against the REAL database using the
# already-built backend. Touches only the node's own health columns.
verify_local_node_via_dist() {
  KCT_NODE_STATUS="unknown"
  KCT_NODE_DETAIL=""
  if [ ! -f "$REPO_ROOT/server/dist/db.js" ]; then
    info "Backend not built in this checkout; skipping direct Local Node check."
    return 1
  fi
  if [ ! -d "$REPO_ROOT/server/node_modules/dotenv" ]; then
    info "Backend dependencies missing here; skipping direct Local Node check."
    return 1
  fi
  local tmp out rc=0
  tmp="$(mktemp)"
  cat > "$tmp" <<'EOF'
const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config();
(async () => {
  const dbm = require("./dist/db.js");
  const hostm = require("./dist/services/virtualization/host.js");
  const db = dbm.getDb();
  const res = await hostm.checkNodeHealth(db, "local");
  console.log("KCT_STATUS=" + res.status);
  console.log("KCT_DETAIL=" + res.detail);
})().catch((e) => { console.error("KCT_ERROR=" + ((e && e.message) || e)); process.exit(1); });
EOF
  out="$(cd "$REPO_ROOT/server" && node "$tmp" 2>&1)" || rc=$?
  rm -f "$tmp"
  if [ "$rc" -ne 0 ]; then
    warn "Direct Local Node check failed; use Nodes → Refresh in the panel."
    printf '%s\n' "$out" | head -5 || true
    return 1
  fi
  KCT_NODE_STATUS="$(printf '%s\n' "$out" | grep -E '^KCT_STATUS=' | cut -d= -f2- || true)"
  KCT_NODE_DETAIL="$(printf '%s\n' "$out" | grep -E '^KCT_DETAIL=' | cut -d= -f2- || true)"
  if [ -z "$KCT_NODE_STATUS" ]; then KCT_NODE_STATUS="unknown"; fi
  return 0
}

# Read-only panel checks: process presence + public health endpoint.
verify_existing_panel() {
  say "Verifying existing panel ..."
  local running=""
  if command -v pm2 >/dev/null 2>&1; then
    if pm2 pid kineticct 2>/dev/null | grep -qE '[0-9]+'; then running="pm2"; fi
  fi
  if [ -z "$running" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet kineticct 2>/dev/null; then running="systemd"; fi
  fi
  if [ -z "$running" ] && command -v pgrep >/dev/null 2>&1; then
    if pgrep -f "dist/index.js" >/dev/null 2>&1; then running="process"; fi
  fi
  if [ -n "$running" ]; then
    info "Panel process is running (via $running) — leaving it untouched."
  else
    warn "No running panel detected (pm2/systemd/process). Start it before verifying the UI."
  fi
  local port="8080" p
  if [ -f "$REPO_ROOT/.env" ]; then
    p="$(grep -E '^PORT=' "$REPO_ROOT/.env" | cut -d= -f2- | tr -d '[:space:]' || true)"
    if [ -n "$p" ]; then port="$p"; fi
  fi
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 10 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
      info "Panel API is healthy at http://127.0.0.1:${port}/api/health."
    else
      warn "Panel API did not answer at port ${port}."
    fi
  else
    warn "curl missing; cannot probe the panel API."
  fi
}

print_lxc_report() {
  say "LXC setup report"
  info "Packages:  ${LXC_PACKAGES}"
  info "Network:   ${LXC_NET}"
  info "LXCFS:     ${LXCFS_STATUS}${LXCFS_DETAIL:+ — $LXCFS_DETAIL}"
  if [ "$LXCFS_CONTAINER" != "pending" ]; then
    info "Probe:     ${LXC_PROBE} (guest LXCFS mounts: $LXCFS_CONTAINER)"
  else
    info "Probe:     ${LXC_PROBE}"
  fi
  info "Status:    ${LXC_STATUS}${LXC_DETAIL:+ — $LXC_DETAIL}"
  if [ -n "$LXC_EVIDENCE" ]; then
    info "Verified tooling (classic LXC — note: there is no \`lxc\` binary; \`lxc list\` is LXD syntax):"
    printf '%s\n' "$LXC_EVIDENCE" | while IFS= read -r line; do
      [ -n "$line" ] && printf '    %s\n' "$line"
    done || true
  fi
  return 0
}

# Repair mode for EXISTING installations: reconcile every managed VPS on the
# local node (re-apply drifted limits, LXCFS include, btrfs quotas).
# Never touches .env, users, settings, ports, service config, unrelated
# containers, storage layouts, or firewall rules. Never destroys/recreates.
repair_vps_only() {
  say "VPS repair mode — existing installation at $REPO_ROOT"
  say "This reconciles managed containers only. Nothing else is modified."
  require_lxc_root die
  if [ ! -f "$REPO_ROOT/server/package.json" ]; then
    die "Not a KineticCT checkout: $REPO_ROOT"
  fi
  # Prove the backend can actually load (handles npm-hoisted layouts where
  # server/node_modules itself may be absent). Never assume from paths.
  if ! (cd "$REPO_ROOT/server" && node -e "require.resolve('dotenv');require.resolve('better-sqlite3')" >/dev/null 2>&1); then
    warn "Backend dependencies do not resolve from $REPO_ROOT/server."
    info "server/node_modules present: $([ -d "$REPO_ROOT/server/node_modules" ] && echo yes || echo no)"
    info "root node_modules present: $([ -d "$REPO_ROOT/node_modules" ] && echo yes || echo no)"
    die "Cannot load the backend — run update.sh (or install.sh) first, then re-run --repair."
  fi
  if [ ! -f "$REPO_ROOT/server/dist/db.js" ]; then
    say "Building the backend (build output only; no data touched) ..."
    (cd "$REPO_ROOT" && npm run build --workspace=server) || die "Backend build failed."
  fi
  local tmp out rc=0
  tmp="$(mktemp)"
  cat > "$tmp" <<'EOF'
const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config();
(async () => {
  const dbm = require("./dist/db.js");
  const agent = require("./dist/services/virtualization/localAgent.js");
  const db = dbm.getDb();
  const { repaired, checkedAt } = await agent.repairLocalInstances(db);
  console.log(JSON.stringify({ checkedAt, repaired }));
})().catch((e) => { console.error("KCT_ERROR=" + ((e && e.message) || e)); process.exit(1); });
EOF
  out="$(cd "$REPO_ROOT/server" && node "$tmp" 2>&1)" || rc=$?
  rm -f "$tmp"
  if [ "$rc" -ne 0 ]; then
    warn "Repair run failed:"
    printf '%s\n' "$out" | head -10 || true
    return 1
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s\n' "$out" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const r=JSON.parse(s);let bad=0;for(const v of r.repaired){const fails=v.checks.filter(c=>c.status==='failed');if(fails.length>0)bad++;console.log('- '+v.containerId);for(const c of v.checks)console.log('    ['+c.status+'] '+c.check+': '+c.detail);}console.log('checked '+r.repaired.length+' instance(s) at '+r.checkedAt);process.exit(bad>0?1:0);}catch(e){console.error('unparseable repair output');process.exit(1);}});" || rc=$?
  else
    printf '%s\n' "$out"
  fi
  if [ "$rc" -ne 0 ]; then
    warn "Repair completed with failures (details above). Rerun after addressing them."
    return 1
  fi
  say "Repair pass complete — see per-instance results above."
  return 0
}

# Setup-only mode for an EXISTING installation. Never touches .env, the
# database contents (beyond node health columns), users, settings, ports,
# service config, existing containers, or firewall rules.
setup_lxc_only() {
  say "LXC setup-only mode — existing installation at $REPO_ROOT"
  say "This will NOT touch .env, the database, users, or the service config."
  require_lxc_root die
  if [ ! -f "$REPO_ROOT/server/package.json" ]; then
    die "Not a KineticCT checkout: $REPO_ROOT"
  fi
  if setup_lxc_host "setup-only"; then
    info "Host integration ready."
  else
    warn "Host integration incomplete (status: $LXC_STATUS)."
  fi
  verify_existing_panel
  if verify_local_node_via_dist; then
    info "Local Node backend check: ${KCT_NODE_STATUS} — ${KCT_NODE_DETAIL}"
  fi
  print_lxc_report
  if [ "$LXC_STATUS" = "ready" ]; then
    say "LXC setup complete and verified. Open Nodes → Refresh to see it live."
    return 0
  fi
  warn "LXC setup incomplete (status: $LXC_STATUS): ${LXC_DETAIL:-see messages above}."
  return 1
}

ensure_base_tools
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
  [ "$SKIP_LXC" -eq 1 ] && set -- "$@" --skip-lxc
  [ "$SETUP_LXC_ONLY" -eq 1 ] && set -- "$@" --setup-lxc-only
  [ "$REPAIR" -eq 1 ] && set -- "$@" --repair
  [ "$PROBE" -eq 1 ] && set -- "$@" --probe
  # Run from inside the fresh checkout, otherwise the check above fails again.
  cd "$INSTALL_DIR" || die "Cannot enter install directory: $INSTALL_DIR"
  exec bash "$INSTALL_DIR/install.sh" "$@"
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# LXC host detection helpers (function definitions only, no side effects).
KCT_LXC_LIB=1
# shellcheck disable=SC1091
if [ -f "$REPO_ROOT/lib/lxc-host.sh" ]; then
  . "$REPO_ROOT/lib/lxc-host.sh"
else
  die "lib/lxc-host.sh is missing — update your checkout (git pull) and re-run."
fi

# Setup-only mode exits here: host LXC work only, never a fresh install.
if [ "$SETUP_LXC_ONLY" -eq 1 ]; then
  setup_lxc_only
  exit $?
fi

# Repair mode exits here: reconcile existing VPS configs only. Never touches
# .env, users, settings, ports, service config, or unrelated containers.
if [ "$REPAIR" -eq 1 ]; then
  repair_vps_only
  exit $?
fi

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
# Native modules (argon2, better-sqlite3, node-pty) need install-script approval on npm 11+.
if npm approve-scripts --help >/dev/null 2>&1; then
  npm approve-scripts argon2 better-sqlite3 esbuild node-pty >/dev/null 2>&1 || true
  npm rebuild argon2 better-sqlite3 node-pty >/dev/null 2>&1 || true
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
# LXC host setup (automatic unless skipped)
# ---------------------------------------------------------------------------
if [ "$SKIP_LXC" -eq 1 ]; then
  info "LXC host setup skipped (--skip-lxc)."
  LXC_STATUS="skipped"
elif [ "$ON_WINDOWS" -eq 1 ]; then
  info "LXC host setup skipped (not a Linux host)."
  LXC_STATUS="skipped"
else
  if require_lxc_root warn; then
    if setup_lxc_host "install"; then
      info "LXC host integration ready."
    else
      warn "Continuing panel install without working LXC (status: $LXC_STATUS)."
    fi
  else
    LXC_STATUS="skipped"
  fi
fi

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
# final verification: Local Node through the real backend
# ---------------------------------------------------------------------------
if [ "$LXC_STATUS" = "ready" ] || [ "$LXC_STATUS" = "unverified" ]; then
  if verify_local_node_via_dist; then
    info "Local Node backend check: ${KCT_NODE_STATUS} — ${KCT_NODE_DETAIL}"
  fi
fi

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
if [ "$LXC_STATUS" != "pending" ] && [ "$LXC_STATUS" != "skipped" ]; then
  info "LXC host: ${LXC_STATUS}${LXC_DETAIL:+ — $LXC_DETAIL} (Nodes page shows the live status)"
fi
if [ "$START_NOW" -eq 1 ] && [ "$SERVICE" = "none" ]; then
  say "Starting the server (Ctrl+C to stop) ..."
  cd "$REPO_ROOT/server" && exec node dist/index.js
elif [ "$SERVICE" = "none" ]; then
  info "Start it with:  cd $REPO_ROOT/server && node dist/index.js"
  info "   (or re-run with --start, or pick --service pm2|systemd)"
fi
