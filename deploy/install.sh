#!/usr/bin/env bash
set -euo pipefail

# StackPI_v2 — Install Script
# Installs system-level dependencies on a fresh Raspberry Pi (Debian/Ubuntu).
# Run as root or with sudo.
#
# Usage:  sudo bash deploy/install.sh
#
# Add new entries to PACKAGES or the installer sections below as the
# project grows.

###############################################################################
# Helpers
###############################################################################

info()  { printf '\n\033[1;34m>>> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }
fail()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$1"; exit 1; }

if [[ $EUID -ne 0 ]]; then
  fail "This script must be run as root (use sudo)."
fi

###############################################################################
# System packages
###############################################################################

info "Updating apt package index"
apt-get update -y

# Core packages — add new apt dependencies here
PACKAGES=(
  # Python
  python3
  python3-venv
  python3-pip

  # Node / npm for the portal are installed separately below (NodeSource
  # Node 20 LTS) — Raspberry Pi OS's apt nodejs (18) is too old for Next.js 16.

  # PostgreSQL
  postgresql
  postgresql-contrib

  # MQTT (clients only — broker is hosted elsewhere)
  mosquitto-clients

  # Kiosk display (Wayland compositor + Chromium). Sway gives us multi-output
  # support (PITFT50 + secondary HDMI). Cage stays installed as a fallback for
  # single-output debugging.
  cage
  sway
  chromium

  # Boot splash — plymouth replaces console text with our logo between
  # kernel handoff and userland services. `plymouth-themes` ships the
  # base themes; our custom 'stackpi' theme is installed by deploy.sh.
  plymouth
  plymouth-themes

  # General utilities
  curl
  ca-certificates
  gnupg
  git
  unzip
)

info "Installing system packages"
apt-get install -y "${PACKAGES[@]}"
ok "System packages installed"

###############################################################################
# Node.js 20 LTS  (for the portal — Next.js 16 needs Node >= 20.9)
###############################################################################
#
# Raspberry Pi OS / Debian Bookworm ships Node 18 in apt, which is too old to
# build the portal. Install Node 20 LTS from NodeSource (which bundles npm).
# Idempotent: skip if a new-enough node is already present.

info "Ensuring Node.js 20 LTS"

NODE_MAJOR_REQUIRED=20
node_major=0
if command -v node &>/dev/null; then
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
fi

if [[ "$node_major" -ge "$NODE_MAJOR_REQUIRED" ]]; then
  ok "Node.js $(node --version) already satisfies >= ${NODE_MAJOR_REQUIRED}"
else
  info "Provisioning NodeSource Node ${NODE_MAJOR_REQUIRED}.x apt repo (found: $(command -v node &>/dev/null && node --version || echo none))"
  # Deterministic, signature-verified install — we do NOT pipe a remote setup
  # script into a root shell. Instead, fetch the NodeSource signing key into a
  # dedicated keyring and pin the repo to it via signed-by, so apt itself
  # cryptographically verifies the nodejs package against that key. The only
  # network-trust step is the HTTPS key fetch; everything installed afterward
  # is apt-signature-verified.
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_REQUIRED}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
  ok "Node.js $(node --version) installed (npm $(npm --version))"
fi

###############################################################################
# pgweb  (lightweight PostgreSQL web UI)
###############################################################################

info "Installing pgweb"

PGWEB_VERSION="0.16.2"
PGWEB_ARCH="linux_arm64"
PGWEB_URL="https://github.com/sosedoff/pgweb/releases/download/v${PGWEB_VERSION}/pgweb_${PGWEB_ARCH}.zip"

if command -v pgweb &>/dev/null; then
  ok "pgweb already installed ($(pgweb --version))"
else
  TMP_DIR=$(mktemp -d)
  curl -fsSL "$PGWEB_URL" -o "${TMP_DIR}/pgweb.zip"
  unzip -o "${TMP_DIR}/pgweb.zip" -d "${TMP_DIR}"
  install -m 755 "${TMP_DIR}/pgweb_${PGWEB_ARCH}" /usr/local/bin/pgweb
  rm -rf "$TMP_DIR"
  ok "pgweb $(pgweb --version) installed"
fi

###############################################################################
# Enable + start system services
###############################################################################

info "Enabling system services"
systemctl enable --now postgresql
ok "postgresql enabled"

###############################################################################
# Summary
###############################################################################

info "Installed versions"
python3          --version
node             --version
npm              --version
psql             --version
pgweb            --version 2>/dev/null || echo "  pgweb: check manually"
# mosquitto_pub closes its help output as a stream — pipefail + head causes
# SIGPIPE (141) which would tank the script. Read with sed which fully drains.
{ mosquitto_pub --help 2>&1 || true; } | sed -n '1p'

info "Install complete"
