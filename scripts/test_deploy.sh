#!/usr/bin/env bash
set -euo pipefail

# StackPI_v2 — Test Deploy Script
# Pushes the local working tree to a test Raspberry Pi via rsync,
# then runs deploy/install.sh and deploy/deploy.sh on the Pi.
#
# For dev iteration only. Reads connection info from scripts/.env.test_deploy.
#
# Requires:  sshpass  (brew install hudochenkov/sshpass/sshpass)
#            rsync    (preinstalled on macOS)
#
# Usage:  bash scripts/test_deploy.sh

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/scripts/.env.test_deploy"

info()  { printf '\n\033[1;34m>>> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }
fail()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$1" >&2; exit 1; }

###############################################################################
# Load env
###############################################################################

if [[ ! -f "$ENV_FILE" ]]; then
  fail "Missing $ENV_FILE — copy scripts/.env.test_deploy.example and fill in."
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${PI_HOST:?PI_HOST not set in $ENV_FILE}"
: "${PI_USER:?PI_USER not set in $ENV_FILE}"
: "${PI_PASSWORD:?PI_PASSWORD not set in $ENV_FILE}"
PI_SSH_PORT="${PI_SSH_PORT:-22}"
PI_DEPLOY_PATH="${PI_DEPLOY_PATH:-/home/$PI_USER/StackPI_v2}"

###############################################################################
# Preflight
###############################################################################

command -v sshpass >/dev/null 2>&1 \
  || fail "sshpass not installed. Install with: brew install hudochenkov/sshpass/sshpass"
command -v rsync >/dev/null 2>&1 \
  || fail "rsync not installed (expected to be present on macOS by default)"

# Use SSHPASS env var (safer than -p — password not visible in process list)
export SSHPASS="$PI_PASSWORD"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -p "$PI_SSH_PORT")

remote() {  # remote <single-string-command>
  sshpass -e ssh "${SSH_OPTS[@]}" "$PI_USER@$PI_HOST" "$1"
}

info "Verifying SSH to $PI_USER@$PI_HOST:$PI_SSH_PORT"
remote 'echo "Connected: $(hostname) $(uname -m)"' \
  || fail "Could not SSH to Pi — check PI_HOST / PI_USER / PI_PASSWORD in $ENV_FILE."
ok "Connection verified"

###############################################################################
# Rsync local tree to the Pi
###############################################################################

info "Rsyncing local tree → $PI_USER@$PI_HOST:$PI_DEPLOY_PATH"
remote "mkdir -p '$PI_DEPLOY_PATH'"

sshpass -e rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude='.git/' \
  --exclude='__pycache__/' \
  --exclude='*.py[cod]' \
  --exclude='.pytest_cache/' \
  --exclude='.mypy_cache/' \
  --exclude='.ruff_cache/' \
  --exclude='.venv/' \
  --exclude='venv/' \
  --exclude='node_modules/' \
  --exclude='.next/' \
  --exclude='.DS_Store' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='scripts/.env.test_deploy' \
  "$REPO_DIR/" \
  "$PI_USER@$PI_HOST:$PI_DEPLOY_PATH/"
ok "Tree synced"

###############################################################################
# Run install.sh + deploy.sh on the Pi
###############################################################################

info "Running deploy/install.sh on Pi (sudo)"
# Pipe password to sudo -S over stdin so this works on a passworded sudo setup.
remote "echo '$PI_PASSWORD' | sudo -S bash '$PI_DEPLOY_PATH/deploy/install.sh'"
ok "install.sh complete"

info "Running deploy/deploy.sh on Pi (SKIP_GIT_PULL=1 — using rsync'd tree)"
remote "SKIP_GIT_PULL=1 bash '$PI_DEPLOY_PATH/deploy/deploy.sh'"
ok "deploy.sh complete"

info "Test deploy finished — $PI_HOST"
