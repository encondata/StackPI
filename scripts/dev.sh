#!/usr/bin/env bash
set -euo pipefail

# StackPI_v2 — Dev Script
# Starts all dev servers for local development (on the Pi or macOS).
# Ctrl+C stops everything.
#
# Usage:  bash scripts/dev.sh

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

info()  { printf '\033[1;34m>>> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }

trap 'echo; info "Shutting down..."; kill 0; wait' EXIT

###############################################################################
# API  (FastAPI with hot reload)
###############################################################################

info "Starting API on :8000"
cd "$REPO_DIR/api"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip -q
  .venv/bin/pip install -e ".[dev]" -q
  ok "API venv created"
fi
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &

###############################################################################
# Portal  (Next.js dev server with hot reload)
###############################################################################

info "Starting Portal on :3000"
cd "$REPO_DIR/portal"
if [[ ! -d node_modules ]]; then
  npm install
  ok "Portal dependencies installed"
fi
npm run dev -- --hostname 0.0.0.0 &

###############################################################################
# Wait for all background processes
###############################################################################

info "Dev servers running — API :8000 | Portal :3000"
wait
