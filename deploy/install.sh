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

  # Node / npm  (for the portal)
  nodejs
  npm

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
  git
  unzip
)

info "Installing system packages"
apt-get install -y "${PACKAGES[@]}"
ok "System packages installed"

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
