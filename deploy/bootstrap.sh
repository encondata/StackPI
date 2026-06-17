#!/usr/bin/env bash
set -euo pipefail

# StackPI bootstrap — provision a fresh Raspberry Pi from scratch in one shot.
#
# Run as the kiosk user (csg), which has sudo. It will prompt for the sudo
# password where root is needed (sudo reads /dev/tty, so this works even when
# the script itself is piped from curl).
#
# Usage (recommended — fetch over HTTPS, then run):
#   curl -fsSL https://raw.githubusercontent.com/encondata/StackPI/main/deploy/bootstrap.sh | bash
#
# What it does:
#   1. ensure git is present
#   2. clone (or fast-forward) the repo into /home/csg/StackPI_v2
#   3. deploy/install.sh                     — system packages + Node 20 + pgweb (root)
#   4. deploy/scripts/setup-pg-memcluster.sh — RAM Postgres + USB snapshot (root, needs USB at /dev/sda1)
#   5. deploy/deploy.sh                      — build api/engine/portal, services, migrations (as csg)
#
# Overridable via env: REPO_URL, BRANCH, TARGET_DIR, SKIP_DB=1 (skip step 4).

REPO_URL="${REPO_URL:-https://github.com/encondata/StackPI.git}"
BRANCH="${BRANCH:-main}"
TARGET_DIR="${TARGET_DIR:-/home/csg/StackPI_v2}"

info()  { printf '\n\033[1;34m>>> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }
warn()  { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }
fail()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$1"; exit 1; }

# --- preconditions ---------------------------------------------------------
if [[ $EUID -eq 0 ]]; then
  fail "Run as the 'csg' kiosk user (not root) — this script uses sudo where it needs root."
fi

RUN_USER="$(id -un)"
if [[ "$RUN_USER" != "csg" ]]; then
  warn "Running as '$RUN_USER', but the systemd units are hardcoded to user 'csg'"
  warn "and ${TARGET_DIR}. Continue only if you've adjusted those, or set TARGET_DIR."
fi

if ! sudo -v; then
  fail "This user needs sudo. Add '$RUN_USER' to the sudo group and re-run."
fi

# --- 1. git ----------------------------------------------------------------
if ! command -v git &>/dev/null; then
  info "Installing git"
  sudo apt-get update -y
  sudo apt-get install -y git
fi
ok "git present"

# --- 2. clone or update ----------------------------------------------------
if [[ -d "$TARGET_DIR/.git" ]]; then
  info "Updating existing checkout at $TARGET_DIR"
  git -C "$TARGET_DIR" fetch --prune origin "$BRANCH"
  git -C "$TARGET_DIR" checkout "$BRANCH"
  git -C "$TARGET_DIR" pull --ff-only origin "$BRANCH"
else
  info "Cloning $REPO_URL ($BRANCH) → $TARGET_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
fi
ok "Repository ready at $TARGET_DIR"

# --- 3. system install -----------------------------------------------------
info "Running install.sh (system packages, Node 20, pgweb)"
sudo bash "$TARGET_DIR/deploy/install.sh"

# --- 4. database (RAM mem-cluster + USB snapshots) -------------------------
if [[ "${SKIP_DB:-0}" == "1" ]]; then
  warn "SKIP_DB=1 — skipping setup-pg-memcluster.sh. The 'stackpi' database will"
  warn "not exist yet, so deploy.sh migrations and the API won't be functional"
  warn "until you run: sudo bash $TARGET_DIR/deploy/scripts/setup-pg-memcluster.sh"
else
  info "Setting up RAM Postgres mem-cluster (needs the USB snapshot drive at /dev/sda1)"
  sudo bash "$TARGET_DIR/deploy/scripts/setup-pg-memcluster.sh"
fi

# --- 5. app deploy ---------------------------------------------------------
# We already synced the repo above, so tell deploy.sh not to git pull again.
info "Running deploy.sh (build api/engine/portal, install services, migrations)"
SKIP_GIT_PULL=1 bash "$TARGET_DIR/deploy/deploy.sh"

# --- 6. kiosk display ------------------------------------------------------
if [[ "${SKIP_KIOSK:-0}" == "1" ]]; then
  warn "SKIP_KIOSK=1 — not enabling the kiosk display. Enable later with:"
  warn "  sudo bash $TARGET_DIR/deploy/scripts/setup-kiosk.sh"
else
  info "Setting up the kiosk display (groups, multi-user target, disable desktop, enable sway)"
  sudo KIOSK_USER="$RUN_USER" bash "$TARGET_DIR/deploy/scripts/setup-kiosk.sh"
fi

# --- done ------------------------------------------------------------------
info "Bootstrap complete"
ok "StackPI is installed at $TARGET_DIR"
cat <<EOF

All set. A reboot gives the cleanest first start of the kiosk display:

  sudo reboot

EOF
