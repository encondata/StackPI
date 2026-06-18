#!/usr/bin/env bash
# StackPI software updater.
#
# Runs as root via a tightly-scoped sudoers entry (csg can only invoke THIS
# script with NOPASSWD; csg cannot modify it because it's root-owned in
# /usr/local/sbin). It runs deploy.sh — the same "git pull + rebuild + restart"
# the bootstrap performs — and reboots on success.
#
# The catch: deploy.sh restarts stackpi-api and stackpi-portal partway through,
# which would kill the API request (and us, if we were its child). So `start`
# launches the real work in a TRANSIENT systemd unit via systemd-run; that unit
# lives in its own cgroup and survives the api/portal restart. The API call
# returns immediately and the UI polls the state/log files below.
#
# Usage:
#   stackpi-update.sh start   # kick off an update (returns at once)
#   stackpi-update.sh run     # the actual work (invoked inside the unit)
#
# Env: STACKPI_REPO_DIR (default /home/csg/StackPI_v2)

set -euo pipefail

REPO_DIR="${STACKPI_REPO_DIR:-/home/csg/StackPI_v2}"
STATE_DIR="/run/stackpi"
STATE_FILE="$STATE_DIR/update.state"   # idle | running | success | failed
LOG_FILE="$STATE_DIR/update.log"
RUN_COPY="$STATE_DIR/update-run.sh"    # snapshot we exec, so deploy.sh
                                       # overwriting our on-disk copy mid-run
                                       # can't corrupt the running script.
UNIT="stackpi-update"

cmd="${1:-start}"

case "$cmd" in
  start)
    install -d -m 0755 "$STATE_DIR"

    # Refuse to stack updates. --collect cleans the unit up when it finishes,
    # so an idle/finished prior run won't block a new one.
    if systemctl is-active --quiet "$UNIT.service"; then
      echo "update already running"
      exit 0
    fi

    : > "$LOG_FILE"
    chmod 0644 "$LOG_FILE"
    echo running > "$STATE_FILE"
    chmod 0644 "$STATE_FILE"

    # Snapshot ourselves and run the snapshot, not the installed path (which
    # deploy.sh reinstalls during the update).
    install -m 0755 "$0" "$RUN_COPY"

    systemd-run \
      --unit="$UNIT" \
      --collect \
      --setenv=STACKPI_REPO_DIR="$REPO_DIR" \
      "$RUN_COPY" run
    echo "update started"
    ;;

  run)
    install -d -m 0755 "$STATE_DIR"
    echo running > "$STATE_FILE"; chmod 0644 "$STATE_FILE"

    # Everything below is teed to the log the UI streams.
    {
      echo ">>> StackPI update starting $(date -Is)"
      echo ">>> repo: $REPO_DIR"
      if bash "$REPO_DIR/deploy/deploy.sh"; then
        echo ">>> deploy.sh succeeded"
        echo success > "$STATE_FILE"; chmod 0644 "$STATE_FILE"
        echo ">>> update complete — rebooting"
        # Brief pause so a final UI poll can observe 'success' before the box
        # goes down. shutdown is the unit's last act, so systemd won't reap a
        # backgrounded child out from under us.
        sleep 3
        /sbin/shutdown -r now
      else
        rc=$?
        echo ">>> deploy.sh FAILED (exit $rc)"
        echo failed > "$STATE_FILE"; chmod 0644 "$STATE_FILE"
        exit "$rc"
      fi
    } >> "$LOG_FILE" 2>&1
    ;;

  *)
    echo "stackpi-update: unknown subcommand: $cmd" >&2
    exit 2
    ;;
esac
