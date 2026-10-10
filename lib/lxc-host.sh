#!/usr/bin/env bash
#
# KineticCT LXC host detection library.
#
# Pure detection helpers (OS, guest type, userns, cgroup, bridge, packages).
# All filesystem probes honor $KCT_ROOT as a prefix, and all host-varying
# commands honor $KCT_CMD_* overrides (defaulting to plain PATH lookup), so
# unit tests can point them at fixtures:
#
#   KCT_ROOT=/tmp/fixture KCT_CMD_UNSHARE=/tmp/fixture/bin/unshare bash lib/lxc-host.sh --self-test
#
# Sourcing this file only defines functions. Executing it directly runs the
# built-in self-test (safe on any machine: fixtures only, nothing mutated).
#
set -euo pipefail

# ---------------------------------------------------------------------------
# probes (KCT_ROOT prefixes every absolute host path for testability)
# ---------------------------------------------------------------------------

kct_path() { # $1 = absolute host path -> test-prefixable path
  printf '%s%s' "${KCT_ROOT:-}" "$1"
}

kct_os_field() { # $1 = KEY from os-release
  local f line
  f="$(kct_path /etc/os-release)"
  [ -r "$f" ] || return 1
  line="$(grep -E "^$1=" "$f" 2>/dev/null | head -n 1 || true)"
  [ -n "$line" ] || return 1
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

kct_os_id() { kct_os_field ID 2>/dev/null || true; }
kct_os_like() { kct_os_field ID_LIKE 2>/dev/null || true; }
kct_os_version_id() { kct_os_field VERSION_ID 2>/dev/null || true; }

kct_detect_guest() {
  # Prints: docker|lxc|openvz|podman|<virt-name>|"" (empty = bare metal/unknown).
  if [ -f "$(kct_path /.dockerenv)" ]; then printf 'docker'; return 0; fi
  local detect="${KCT_CMD_DETECT_VIRT:-systemd-detect-virt}" virt=""
  if command -v "$detect" >/dev/null 2>&1; then
    virt="$("$detect" 2>/dev/null || true)"
  fi
  virt="$(printf '%s' "$virt" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [ -n "$virt" ] && [ "$virt" != "none" ]; then printf '%s' "$virt"; return 0; fi
  local cg=""
  if [ -r "$(kct_path /proc/1/cgroup)" ]; then
    cg="$(cat "$(kct_path /proc/1/cgroup)" 2>/dev/null || true)"
  elif [ -r "$(kct_path /proc/self/cgroup)" ]; then
    cg="$(cat "$(kct_path /proc/self/cgroup)" 2>/dev/null || true)"
  fi
  if printf '%s' "$cg" | grep -qiE 'docker|kubepods|containerd|crio'; then printf 'docker'; return 0; fi
  if printf '%s' "$cg" | grep -qiE '(^|/)lxc[/-]'; then printf 'lxc'; return 0; fi
  if printf '%s' "$cg" | grep -qiE '(^|[^[:alnum:]_])lxd([^[:alnum:]_]|$)'; then printf 'lxc'; return 0; fi
  if printf '%s' "$cg" | grep -qiE 'openvz|(^|[^[:alnum:]_])vz([^[:alnum:]_]|$)'; then printf 'openvz'; return 0; fi
  if printf '%s' "$cg" | grep -qiE 'podman'; then printf 'podman'; return 0; fi
  return 0
}

kct_restricted_guest() { # $1 = guest name; rc 0 when nested LXC is likely blocked
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    docker|lxc|lxd|openvz|podman|container) return 0 ;;
    *) return 1 ;;
  esac
}

kct_userns() {
  # yes = unprivileged user namespaces work, no = blocked, unknown = untestable.
  local unshare="${KCT_CMD_UNSHARE:-unshare}"
  command -v "$unshare" >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  if "$unshare" -U true 2>/dev/null; then printf 'yes'; else printf 'no'; fi
}

kct_cgroup() {
  # v1 | v2 | hybrid | none
  local sys v2=0 v1=0
  sys="$(kct_path /sys/fs/cgroup)"
  [ -f "$sys/cgroup.controllers" ] && v2=1
  for c in memory cpu pids; do
    if [ -d "$sys/$c" ]; then v1=1; break; fi
  done
  if [ "$v2" -eq 1 ] && [ "$v1" -eq 1 ]; then printf 'hybrid'
  elif [ "$v2" -eq 1 ]; then printf 'v2'
  elif [ "$v1" -eq 1 ] || [ -d "$sys" ]; then printf 'v1'
  else printf 'none'; fi
}

kct_bridge() { # $1 = bridge name (default lxcbr0): present|absent|unknown
  local br="${1:-lxcbr0}" ip="${KCT_CMD_IP:-ip}"
  command -v "$ip" >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  if "$ip" -o link show "$br" >/dev/null 2>&1; then printf 'present'; else printf 'absent'; fi
}

kct_ipfwd() {
  # 1 | 0 | unknown
  local f v
  f="$(kct_path /proc/sys/net/ipv4/ip_forward)"
  [ -r "$f" ] || { printf 'unknown'; return 0; }
  v="$(cat "$f" 2>/dev/null | tr -d '[:space:]')"
  case "$v" in 1) printf '1' ;; 0) printf '0' ;; *) printf 'unknown' ;; esac
}

kct_distro_supported() { # $1 = os id, $2 = id_like; rc 0 when apt-based LXC setup is known
  case "${1:-}" in
    debian|ubuntu|raspbian) return 0 ;;
  esac
  case " ${2:-} " in
    *" debian "*|*" ubuntu "*) return 0 ;;
  esac
  return 1
}

kct_lxc_packages() { # $1 = package manager; prints the package list or rc 1
  case "${1:-}" in
    apt) printf 'lxc uidmap libpam-cgfs bridge-utils dnsmasq-base squashfs-tools wget ca-certificates' ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# self-test (fixtures only — safe to run anywhere, mutates nothing)
# ---------------------------------------------------------------------------

KCT_TEST_FAIL=0

kct_assert_eq() { # $1 description, $2 expected, $3 actual
  if [ "$2" = "$3" ]; then
    printf '  ok: %s\n' "$1"
  else
    printf '  FAIL: %s (expected %s, got %s)\n' "$1" "$2" "$3"
    KCT_TEST_FAIL=1
  fi
}

kct_assert_rc() { # $1 description, $2 expected rc, rest = command
  local desc="$1" want="$2"
  shift 2
  local got=0
  "$@" >/dev/null 2>&1 || got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok: %s\n' "$desc"
  else
    printf '  FAIL: %s (expected rc %s, got %s)\n' "$desc" "$want" "$got"
    KCT_TEST_FAIL=1
  fi
}

kct_self_test() {
  printf 'KineticCT LXC detection self-test\n'
  local root
  root="$(mktemp -d)"
  export KCT_ROOT="$root"
  mkdir -p "$root/etc" "$root/proc/1" "$root/proc/self" "$root/proc/sys/net/ipv4" \
    "$root/sys/fs/cgroup" "$root/fakebin"
  # Fixture commands are invoked by absolute path via KCT_CMD_* overrides, so
  # no real lxc/ip/unshare/detect-virt can leak in on any machine.

  stub() { # $1 name, $2 body — creates an executable fixture command
    printf '#!/bin/sh\n%s\n' "$2" > "$root/fakebin/$1"
    chmod +x "$root/fakebin/$1"
  }
  stub systemd-detect-virt 'printf "%s" "${KCT_STUB_VIRT:-none}"'
  stub unshare 'exit ${KCT_STUB_UNSHARE_RC:-0}'
  stub ip 'exit ${KCT_STUB_IP_RC:-0}'
  export KCT_CMD_DETECT_VIRT="$root/fakebin/systemd-detect-virt"
  export KCT_CMD_UNSHARE="$root/fakebin/unshare"
  export KCT_CMD_IP="$root/fakebin/ip"

  # --- os-release ---
  cat > "$root/etc/os-release" <<'EOF'
NAME="Ubuntu"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
VERSION_ID="24.04"
EOF
  kct_assert_eq "os id" "ubuntu" "$(kct_os_id)"
  kct_assert_eq "os like" "debian" "$(kct_os_like)"
  kct_assert_eq "os version" "24.04" "$(kct_os_version_id)"
  mv "$root/etc/os-release" "$root/etc/os-release.hidden"
  kct_assert_eq "os id missing file" "" "$(kct_os_id)"
  mv "$root/etc/os-release.hidden" "$root/etc/os-release"

  # --- guest detection ---
  printf '12:memory:/docker/abc123\n1:name=systemd:/docker/abc123\n' > "$root/proc/1/cgroup"
  kct_assert_eq "docker via cgroup" "docker" "$(KCT_STUB_VIRT=none kct_detect_guest)"
  printf '2:cpu:/lxc/panel\n' > "$root/proc/1/cgroup"
  kct_assert_eq "lxc via cgroup" "lxc" "$(KCT_STUB_VIRT=none kct_detect_guest)"
  printf '0::/\n' > "$root/proc/1/cgroup"
  kct_assert_eq "bare metal cgroup v2" "" "$(KCT_STUB_VIRT=none kct_detect_guest)"
  kct_assert_eq "virt output wins" "qemu" "$(KCT_STUB_VIRT=qemu kct_detect_guest)"
  : > "$root/.dockerenv"
  kct_assert_eq "dockerenv wins" "docker" "$(KCT_STUB_VIRT=qemu kct_detect_guest)"
  rm -f "$root/.dockerenv"

  kct_assert_rc "docker restricted" 0 kct_restricted_guest docker
  kct_assert_rc "lxc restricted" 0 kct_restricted_guest LXC
  kct_assert_rc "qemu not restricted" 1 kct_restricted_guest qemu
  kct_assert_rc "empty not restricted" 1 kct_restricted_guest ""

  # --- userns / cgroup / bridge / ipfwd ---
  kct_assert_eq "userns yes" "yes" "$(KCT_STUB_UNSHARE_RC=0 kct_userns)"
  kct_assert_eq "userns no" "no" "$(KCT_STUB_UNSHARE_RC=1 kct_userns)"
  kct_assert_eq "userns unknown without binary" "unknown" "$(KCT_CMD_UNSHARE=/nonexistent kct_userns)"

  : > "$root/sys/fs/cgroup/cgroup.controllers"
  kct_assert_eq "cgroup v2" "v2" "$(kct_cgroup)"
  mkdir -p "$root/sys/fs/cgroup/memory"
  kct_assert_eq "cgroup hybrid" "hybrid" "$(kct_cgroup)"
  rm -f "$root/sys/fs/cgroup/cgroup.controllers"
  kct_assert_eq "cgroup v1" "v1" "$(kct_cgroup)"
  rm -rf "$root/sys/fs/cgroup"
  kct_assert_eq "cgroup none" "none" "$(kct_cgroup)"
  mkdir -p "$root/sys/fs/cgroup"

  kct_assert_eq "bridge present" "present" "$(KCT_STUB_IP_RC=0 kct_bridge)"
  kct_assert_eq "bridge absent" "absent" "$(KCT_STUB_IP_RC=1 kct_bridge)"
  kct_assert_eq "bridge unknown without ip" "unknown" "$(KCT_CMD_IP=/nonexistent kct_bridge)"

  printf '1' > "$root/proc/sys/net/ipv4/ip_forward"
  kct_assert_eq "ipfwd on" "1" "$(kct_ipfwd)"
  printf '0' > "$root/proc/sys/net/ipv4/ip_forward"
  kct_assert_eq "ipfwd off" "0" "$(kct_ipfwd)"
  rm -f "$root/proc/sys/net/ipv4/ip_forward"
  kct_assert_eq "ipfwd unknown" "unknown" "$(kct_ipfwd)"

  # --- distro + packages ---
  kct_assert_rc "ubuntu supported" 0 kct_distro_supported ubuntu debian
  kct_assert_rc "debian supported" 0 kct_distro_supported debian ""
  kct_assert_rc "mint via like" 0 kct_distro_supported linuxmint ubuntu
  kct_assert_rc "fedora unsupported" 1 kct_distro_supported fedora ""
  kct_assert_rc "empty unsupported" 1 kct_distro_supported "" ""
  kct_assert_eq "apt packages" \
    "lxc uidmap libpam-cgfs bridge-utils dnsmasq-base squashfs-tools wget ca-certificates" \
    "$(kct_lxc_packages apt)"
  kct_assert_rc "dnf packages unsupported" 1 kct_lxc_packages dnf

  rm -rf "$root"
  unset KCT_ROOT
  if [ "$KCT_TEST_FAIL" -eq 0 ]; then
    printf 'self-test: all passed\n'
  else
    printf 'self-test: FAILURES present\n' >&2
  fi
  return "$KCT_TEST_FAIL"
}

# Only dispatch when executed directly; sourcing defines functions silently.
# install.sh sets KCT_LXC_LIB before sourcing.
if [ -z "${KCT_LXC_LIB:-}" ]; then
  case "${1:-}" in
    --self-test) kct_self_test ;;
    *) printf 'KineticCT LXC detection library. Usage: %s --self-test\n' "$0" >&2; exit 2 ;;
  esac
fi
