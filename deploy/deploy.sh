#!/usr/bin/env bash
set -euo pipefail

# StackPI_v2 — Deploy Script
# Pulls the latest code and rebuilds services on the Raspberry Pi.
#
# Usage:  bash deploy/deploy.sh
#
# Assumes install.sh has already been run and system deps are present.

###############################################################################
# Config
###############################################################################

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

###############################################################################
# Helpers
###############################################################################

info()  { printf '\n\033[1;34m>>> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }
fail()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$1"; exit 1; }

# EUID-aware build steps. This script runs in two modes:
#   * Interactively as the kiosk user (csg) — bootstrap and manual deploys.
#   * As root — the in-app updater (stackpi-update.sh) runs us inside a
#     transient systemd unit.
# The privileged steps below use plain `sudo`, which works in BOTH modes (root
# runs sudo without a prompt). Only the build/git steps differ: when we're root
# they MUST drop to the repo owner so .git/.venv/node_modules stay user-owned
# (npm/pip misbehave as root, and the services run as that user).
BUILD_USER="${BUILD_USER:-$(stat -c '%U' "$REPO_DIR")}"
if [[ $EUID -eq 0 ]]; then
  asuser() { runuser -u "$BUILD_USER" -- "$@"; }
else
  asuser() { "$@"; }
fi

###############################################################################
# Pull latest code
###############################################################################

cd "$REPO_DIR"
if [[ "${SKIP_GIT_PULL:-0}" == "1" ]]; then
  info "Skipping git pull (SKIP_GIT_PULL=1)"
elif [[ -n "${TARGET_BRANCH:-}" ]]; then
  # Targeted deploy (in-app updater's branch/commit picker): switch to the
  # requested branch and hard-reset to the chosen commit (or the branch tip).
  # reset --hard discards local tracked changes — fine for a deploy target
  # (build artifacts are gitignored), and it's the only way to switch across
  # diverged branches (a plain ff-only pull can't).
  target="${TARGET_COMMIT:-origin/$TARGET_BRANCH}"
  info "Deploying branch '$TARGET_BRANCH' @ ${TARGET_COMMIT:-tip}"
  asuser git fetch --prune origin "$TARGET_BRANCH"
  asuser git checkout -f -B "$TARGET_BRANCH" "origin/$TARGET_BRANCH"
  asuser git reset --hard "$target"
  ok "Checked out $TARGET_BRANCH @ $(asuser git rev-parse --short HEAD)"
else
  info "Pulling latest code"
  asuser git pull --ff-only
  ok "Code updated"
fi

###############################################################################
# API  (FastAPI)
###############################################################################

info "Setting up API"
cd "$REPO_DIR/api"
asuser python3 -m venv .venv
asuser .venv/bin/pip install --upgrade pip -q
asuser .venv/bin/pip install -e ".[dev]" -q
ok "API dependencies installed"

###############################################################################
# Engine  (Python agent)
###############################################################################

info "Setting up Engine"
cd "$REPO_DIR/engine"
asuser python3 -m venv .venv
asuser .venv/bin/pip install --upgrade pip -q
asuser .venv/bin/pip install -e ".[dev]" -q
ok "Engine dependencies installed"

###############################################################################
# Portal  (Next.js)
###############################################################################

info "Setting up Portal"
cd "$REPO_DIR/portal"
asuser npm ci
asuser npm run build
ok "Portal built"

###############################################################################
# Install systemd units
###############################################################################

info "Installing systemd unit files"
sudo cp "$REPO_DIR/deploy/services/"*.service /etc/systemd/system/ 2>/dev/null || true
sudo cp "$REPO_DIR/deploy/services/"*.timer   /etc/systemd/system/ 2>/dev/null || true
sudo systemctl daemon-reload
ok "Unit files loaded"

###############################################################################
# Apply SQL migrations
###############################################################################
# Each file is expected to be idempotent (CREATE TABLE IF NOT EXISTS, etc.)
# so re-running on every deploy is safe. This catches new migrations added
# between Pi boots — without this they'd only land after a power cycle.

info "Applying SQL migrations"
SQL_DIR="$REPO_DIR/db/sql"
if [[ -d "$SQL_DIR" ]]; then
  for sql in "$SQL_DIR"/*.sql; do
    sudo -u postgres psql -d stackpi -v ON_ERROR_STOP=1 < "$sql" >/dev/null 2>&1 \
      && echo "  ✓ $(basename "$sql")" \
      || echo "  ✗ $(basename "$sql") (non-zero — may already be applied)"
  done
  ok "Migrations applied"
fi

###############################################################################
# Install privileged settings helper + sudoers drop-in
###############################################################################

###############################################################################
# Install kiosk assets (sway config + launcher)
###############################################################################

info "Installing kiosk assets"
sudo install -d -m 0755 /etc/stackpi
sudo install -m 0644 "$REPO_DIR/deploy/sway/sway-kiosk.conf" /etc/stackpi/sway-kiosk.conf
sudo install -m 0644 "$REPO_DIR/deploy/assets/stackpi-logo.png" /etc/stackpi/stackpi-logo.png
sudo install -m 0755 "$REPO_DIR/deploy/scripts/stackpi-kiosk-launch.sh" /usr/local/bin/
# Bad-tag alert sounds (played by the API's app/alerts.py).
sudo install -d -m 0755 /etc/stackpi/sounds
sudo install -m 0644 "$REPO_DIR/deploy/assets/sounds/"*.wav /etc/stackpi/sounds/
ok "kiosk assets installed"

###############################################################################
# Install plymouth boot splash (StackPI logo)
###############################################################################
# Copies the custom theme into /usr/share/plymouth/themes/stackpi, makes
# it the default, and rebuilds the initramfs so the theme ships inside
# the early-boot image (required — plymouth runs before the rootfs is
# mounted in the normal sense).
#
# Also ensures `quiet splash` are on the kernel cmdline so plymouth
# actually replaces the console; without those the splash never shows.
# Edits /boot/firmware/cmdline.txt (Bookworm path) or /boot/cmdline.txt
# (older) — whichever exists. Idempotent: re-runs are no-ops once the
# flags are present.

info "Installing plymouth boot splash"
# plymouth ships its setup script in /usr/sbin (not on the default csg
# PATH). Resolve to the absolute path so we don't depend on PATH.
PLYMOUTH_SET=/usr/sbin/plymouth-set-default-theme
if sudo test -x "$PLYMOUTH_SET"; then
  sudo install -d -m 0755 /usr/share/plymouth/themes/stackpi
  sudo install -m 0644 "$REPO_DIR/deploy/plymouth/stackpi/stackpi.plymouth" \
                       /usr/share/plymouth/themes/stackpi/stackpi.plymouth
  sudo install -m 0644 "$REPO_DIR/deploy/plymouth/stackpi/stackpi.script" \
                       /usr/share/plymouth/themes/stackpi/stackpi.script
  sudo install -m 0644 "$REPO_DIR/deploy/assets/stackpi-logo.png" \
                       /usr/share/plymouth/themes/stackpi/stackpi.png

  # Ensure `quiet splash` is on the kernel cmdline so plymouth replaces
  # the console output. Pi Bookworm uses /boot/firmware/cmdline.txt.
  CMDLINE_FILE=""
  if [[ -f /boot/firmware/cmdline.txt ]]; then
    CMDLINE_FILE=/boot/firmware/cmdline.txt
  elif [[ -f /boot/cmdline.txt ]]; then
    CMDLINE_FILE=/boot/cmdline.txt
  fi
  if [[ -n "$CMDLINE_FILE" ]]; then
    for flag in quiet splash; do
      if ! grep -qw "$flag" "$CMDLINE_FILE"; then
        sudo sed -i "1 s/\$/ $flag/" "$CMDLINE_FILE"
      fi
    done
  fi

  # plymouth-set-default-theme -R writes the default + rebuilds the
  # initramfs in one shot. The rebuild can take 10-30s on a Pi.
  sudo "$PLYMOUTH_SET" -R stackpi >/dev/null
  ok "plymouth splash installed (theme=stackpi)"
else
  echo "  $PLYMOUTH_SET not found — apt install plymouth then re-run deploy"
fi

info "Installing settings helper + sudoers drop-in"
sudo install -m 0755 "$REPO_DIR/deploy/scripts/stackpi-settings-helper.sh" /usr/local/sbin/
# Validate sudoers syntax before installing — a broken sudoers file would
# lock out sudo entirely.
if sudo visudo -c -f "$REPO_DIR/deploy/sudoers.d/stackpi-settings" >/dev/null; then
  sudo install -m 0440 "$REPO_DIR/deploy/sudoers.d/stackpi-settings" /etc/sudoers.d/stackpi-settings
  ok "settings helper + sudoers drop-in installed"
else
  fail "sudoers.d/stackpi-settings failed visudo syntax check; aborting"
fi

# Software updater: lets Config → Update trigger this very script (git pull +
# rebuild + restart) as root, inside a transient systemd unit so it survives
# the api/portal restart it performs. csg gets NOPASSWD for the one root-owned
# script only — same locked-down posture as the settings helper above.
info "Installing software updater + sudoers drop-in"
sudo install -m 0755 "$REPO_DIR/deploy/scripts/stackpi-update.sh" /usr/local/sbin/
if sudo visudo -c -f "$REPO_DIR/deploy/sudoers.d/stackpi-update" >/dev/null; then
  sudo install -m 0440 "$REPO_DIR/deploy/sudoers.d/stackpi-update" /etc/sudoers.d/stackpi-update
  ok "updater + sudoers drop-in installed"
else
  fail "sudoers.d/stackpi-update failed visudo syntax check; aborting"
fi

###############################################################################
# Restart services
###############################################################################

info "Enabling + restarting services"
# Enable so they survive reboot; restart to pick up new code.
# stackpi-kiosk is intentionally NOT auto-enabled here — it requires Pi-side
# prep (multi-user.target, lightdm disabled, autologin removed). Enable it
# manually once after first deploy: sudo systemctl enable --now stackpi-kiosk
for svc in stackpi-api stackpi-engine stackpi-portal stackpi-pgweb; do
  sudo systemctl enable  "$svc.service" 2>/dev/null || true
  sudo systemctl restart "$svc.service" 2>/dev/null && ok "$svc enabled+restarted" \
    || echo "  $svc not yet configured"
done

# Timers — we enable+start the .timer (not the underlying service). The
# service is one-shot; the timer fires it on schedule.
for tmr in stackpi-rfid-poll stackpi-scan-upload; do
  sudo systemctl enable  "$tmr.timer" 2>/dev/null || true
  sudo systemctl restart "$tmr.timer" 2>/dev/null && ok "$tmr.timer enabled+restarted" \
    || echo "  $tmr.timer not yet configured"
done

info "Deploy complete"
