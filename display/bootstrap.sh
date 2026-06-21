#!/usr/bin/env bash
set -euo pipefail

# StackPI status-display bootstrap — provision a remote display Pi (Pi 3+).
#
# Installs ONLY the slim display stack: a multicast receiver + a kiosk browser
# showing the primary's /status + /trucks (a static export of the portal). No
# Postgres, no FastAPI, no portal runtime — the export is built once here and
# served statically by the receiver.
#
# Run as the kiosk user 'csg' (has sudo). One-liner:
#   curl -fsSL https://raw.githubusercontent.com/encondata/StackPI/dev/display/bootstrap.sh | bash
#
# Two modes (STACKPI_DISPLAY_MODE):
#   bootstrap (default) — full provision: packages, build, install, kiosk, reboot.
#   update              — re-run by the in-app updater (display/update.sh) inside
#                         a transient unit AS ROOT: skip packages/kiosk-prep,
#                         honor TARGET_BRANCH/TARGET_COMMIT, restart services
#                         (no reboot). Build steps drop to the kiosk user.
#
# Overridable via env: REPO_URL, BRANCH, TARGET_DIR, KIOSK_USER, SKIP_REBOOT=1,
#   TARGET_BRANCH, TARGET_COMMIT.

REPO_URL="${REPO_URL:-https://github.com/encondata/StackPI.git}"
BRANCH="${BRANCH:-dev}"
TARGET_DIR="${TARGET_DIR:-/home/csg/StackPI_v2}"
KIOSK_USER="${KIOSK_USER:-csg}"
APP_DIR="/opt/stackpi-display"
CFG_DIR="/etc/stackpi-display"
MODE="${STACKPI_DISPLAY_MODE:-bootstrap}"

info()  { printf '\n\033[1;34m>>> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }
warn()  { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }
fail()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$1"; exit 1; }

# EUID-aware build steps (same approach as the primary's deploy.sh). The updater
# runs us as root in a transient unit; bootstrap runs us as the kiosk user.
# `sudo` works in both modes (root runs it without a prompt); only the git/npm
# steps must drop to the repo owner so .git/node_modules stay user-owned.
if [[ $EUID -eq 0 ]]; then
  asuser() { runuser -u "$KIOSK_USER" -- "$@"; }
else
  asuser() { "$@"; }
fi

if [[ "$MODE" == "bootstrap" ]]; then
  [[ $EUID -eq 0 ]] && fail "Run as the kiosk user (not root); the script sudo's where needed."
  sudo -v || fail "This user needs sudo."
fi

# --- 1. packages -----------------------------------------------------------
if [[ "$MODE" == "bootstrap" ]]; then
  info "Installing packages (chromium, sway, git, node+npm for the one-time export build)"
  sudo apt-get update -y
  sudo apt-get install -y git curl ca-certificates chromium sway

  # Node + npm for the one-time export build. The distro nodejs package does NOT
  # bundle npm (it's a separate package), so install both. Pi OS trixie ships
  # Node 20 already; only fall back to NodeSource if the distro Node is <20.
  sudo apt-get install -y nodejs npm
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$NODE_MAJOR" -lt 20 ]]; then
    info "Distro Node is $NODE_MAJOR (<20) — installing Node 20 from NodeSource"
    sudo install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    sudo apt-get update -y && sudo apt-get install -y nodejs
  fi
  command -v npm >/dev/null || sudo apt-get install -y npm
  ok "packages installed (node $(node -v 2>/dev/null || echo '?'), npm $(npm -v 2>/dev/null || echo '?'))"
else
  info "Update mode — skipping package install"
fi

# --- 2. repo ---------------------------------------------------------------
# Honor an updater-supplied target (branch + optional commit); otherwise track
# the configured BRANCH tip.
EFF_BRANCH="${TARGET_BRANCH:-$BRANCH}"
if [[ -d "$TARGET_DIR/.git" ]]; then
  info "Updating $TARGET_DIR ($EFF_BRANCH @ ${TARGET_COMMIT:-tip})"
  asuser git -C "$TARGET_DIR" fetch --prune origin "$EFF_BRANCH"
  asuser git -C "$TARGET_DIR" checkout -f -B "$EFF_BRANCH" "origin/$EFF_BRANCH"
  asuser git -C "$TARGET_DIR" reset --hard "${TARGET_COMMIT:-origin/$EFF_BRANCH}"
else
  info "Cloning $REPO_URL ($EFF_BRANCH)"
  asuser git clone --branch "$EFF_BRANCH" "$REPO_URL" "$TARGET_DIR"
fi
ok "repo at $TARGET_DIR @ $(asuser git -C "$TARGET_DIR" rev-parse --short HEAD)"

# --- 3. static export of the portal kiosk pages ----------------------------
info "Building the static export (slow on a Pi)"
cd "$TARGET_DIR/portal"
asuser npm ci
asuser env STACKPI_DISPLAY_EXPORT=1 npm run build
[[ -d out ]] || fail "export did not produce portal/out (check the build log above)"
sudo install -d -m 0755 "$APP_DIR/web"
sudo rsync -a --delete out/ "$APP_DIR/web/"
ok "exported portal → $APP_DIR/web"

# --- 4. receiver + config + updater + units --------------------------------
info "Installing the receiver + config + services"
sudo install -m 0755 "$TARGET_DIR/display/receiver.py" "$APP_DIR/receiver.py"
sudo install -m 0644 "$TARGET_DIR/display/setup.html" "$APP_DIR/setup.html"
sudo install -d -m 0755 "$CFG_DIR"
if [[ ! -f "$CFG_DIR/config.json" ]]; then
  sudo install -m 0644 "$TARGET_DIR/display/config.example.json" "$CFG_DIR/config.json"
fi
# The receiver (runs as the kiosk user) rewrites config.json from the /setup page.
sudo chown "$KIOSK_USER:$KIOSK_USER" "$CFG_DIR/config.json"
# Privileged updater (root-owned in /usr/local/sbin so the kiosk user can't edit
# it) + the scoped NOPASSWD sudoers entry that lets the receiver invoke it.
sudo install -m 0755 "$TARGET_DIR/display/update.sh" /usr/local/sbin/stackpi-display-update.sh
sudo install -m 0440 "$TARGET_DIR/display/sudoers.d/stackpi-display-update" /etc/sudoers.d/stackpi-display-update
sudo install -m 0644 "$TARGET_DIR/display/sway-display.conf" /etc/stackpi-display/sway-display.conf
sudo install -m 0755 "$TARGET_DIR/display/display-kiosk-launch.sh" /usr/local/bin/display-kiosk-launch.sh
sudo cp "$TARGET_DIR/display/"*.service /etc/systemd/system/
sudo systemctl daemon-reload
ok "receiver + updater + units installed"

# --- 5a. update mode: restart services, done -------------------------------
if [[ "$MODE" == "update" ]]; then
  info "Restarting display services"
  sudo systemctl restart stackpi-display.service
  sudo systemctl restart stackpi-display-kiosk.service 2>/dev/null || true
  ok "update complete"
  exit 0
fi

# --- 5b. kiosk prep (bootstrap only; mirrors the primary's setup-kiosk) -----
info "Kiosk prep: groups, multi-user target, disable display manager"
sudo usermod -aG video,input,render,tty "$KIOSK_USER"
sudo systemctl set-default multi-user.target >/dev/null
for dm in display-manager lightdm gdm3 gdm sddm; do sudo systemctl disable --now "${dm}.service" 2>/dev/null || true; done

sudo systemctl enable --now stackpi-display.service
sudo systemctl reset-failed stackpi-display-kiosk.service 2>/dev/null || true
sudo systemctl enable stackpi-display-kiosk.service
ok "services enabled"

info "Display bootstrap complete"
if [[ "${SKIP_REBOOT:-0}" == "1" ]]; then
  warn "SKIP_REBOOT=1 — reboot when ready: sudo reboot"
else
  sudo -v || true
  warn "Rebooting in 10s for a clean kiosk start — Ctrl-C to cancel."
  sleep 10
  sudo reboot
fi
