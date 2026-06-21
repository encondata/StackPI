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
# Overridable via env: REPO_URL, BRANCH, TARGET_DIR, KIOSK_USER, SKIP_REBOOT=1.

REPO_URL="${REPO_URL:-https://github.com/encondata/StackPI.git}"
BRANCH="${BRANCH:-dev}"
TARGET_DIR="${TARGET_DIR:-/home/csg/StackPI_v2}"
KIOSK_USER="${KIOSK_USER:-csg}"
APP_DIR="/opt/stackpi-display"
CFG_DIR="/etc/stackpi-display"

info()  { printf '\n\033[1;34m>>> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }
warn()  { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }
fail()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$1"; exit 1; }

[[ $EUID -eq 0 ]] && fail "Run as the kiosk user (not root); the script sudo's where needed."
sudo -v || fail "This user needs sudo."

# --- 1. packages -----------------------------------------------------------
info "Installing packages (chromium, sway, git, node for the one-time export build)"
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates chromium sway

# Node 20 (NodeSource) — only needed to build the static export once.
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]]; then
  info "Installing Node 20 (for the export build)"
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y nodejs
fi
ok "packages installed"

# --- 2. repo ---------------------------------------------------------------
if [[ -d "$TARGET_DIR/.git" ]]; then
  info "Updating $TARGET_DIR ($BRANCH)"
  git -C "$TARGET_DIR" fetch --prune origin "$BRANCH"
  git -C "$TARGET_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH"
  git -C "$TARGET_DIR" reset --hard "origin/$BRANCH"
else
  info "Cloning $REPO_URL ($BRANCH)"
  git clone --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
fi
ok "repo at $TARGET_DIR"

# --- 3. static export of the portal kiosk pages ----------------------------
info "Building the static export (one-time; slow on a Pi)"
cd "$TARGET_DIR/portal"
npm ci
STACKPI_DISPLAY_EXPORT=1 npm run build
[[ -d out ]] || fail "export did not produce portal/out (check the build log above)"
sudo install -d -m 0755 "$APP_DIR/web"
sudo rsync -a --delete out/ "$APP_DIR/web/"
ok "exported portal → $APP_DIR/web"

# --- 4. receiver + config + units ------------------------------------------
info "Installing the receiver + config + services"
sudo install -m 0755 "$TARGET_DIR/display/receiver.py" "$APP_DIR/receiver.py"
sudo install -d -m 0755 "$CFG_DIR"
if [[ ! -f "$CFG_DIR/config.json" ]]; then
  sudo install -m 0644 "$TARGET_DIR/display/config.example.json" "$CFG_DIR/config.json"
fi
sudo install -m 0644 "$TARGET_DIR/display/sway-display.conf" /etc/stackpi-display/sway-display.conf
sudo install -m 0755 "$TARGET_DIR/display/display-kiosk-launch.sh" /usr/local/bin/display-kiosk-launch.sh
sudo cp "$TARGET_DIR/display/"*.service /etc/systemd/system/
sudo systemctl daemon-reload
ok "receiver + units installed"

# --- 5. kiosk prep (mirrors the primary's setup-kiosk) ---------------------
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
