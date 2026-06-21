#!/usr/bin/env bash
# StackPI display updater.
#
# Runs as root via a tightly-scoped sudoers entry (the kiosk user can only
# invoke THIS script with NOPASSWD; it's root-owned in /usr/local/sbin so the
# kiosk user can't modify it). It re-runs display/bootstrap.sh in `update` mode
# — git pull + rebuild the export + reinstall + restart the services.
#
# The catch (same as the primary's updater): the reinstall restarts
# stackpi-display.service, which is the receiver that handled the API request —
# killing it mid-update. So `start` launches the real work in a TRANSIENT
# systemd unit via systemd-run; that unit lives in its own cgroup and survives
# the receiver restart. The API call returns immediately and the UI polls the
# state/log files below.
#
# Usage:
#   stackpi-display-update.sh start [branch] [commit]   # kick off (returns now)
#   stackpi-display-update.sh run                        # the work (in the unit)
#
# Env: STACKPI_DISPLAY_REPO_DIR (default /home/csg/StackPI_v2),
#      STACKPI_DISPLAY_USER (default csg)

set -euo pipefail

REPO_DIR="${STACKPI_DISPLAY_REPO_DIR:-/home/csg/StackPI_v2}"
KIOSK_USER="${STACKPI_DISPLAY_USER:-csg}"
STATE_DIR="/run/stackpi-display"
STATE_FILE="$STATE_DIR/update.state"   # idle | running | success | failed
LOG_FILE="$STATE_DIR/update.log"
RUN_COPY="$STATE_DIR/update-run.sh"    # snapshot we exec, so the reinstall
                                       # overwriting our on-disk copy mid-run
                                       # can't corrupt the running script.
UNIT="stackpi-display-update"

cmd="${1:-start}"

case "$cmd" in
  start)
    install -d -m 0755 "$STATE_DIR"

    branch="${2:-}"
    commit="${3:-}"
    # Defense in depth: these reach `git checkout`/`reset`. Allow only safe
    # git-ref characters (the receiver validates too).
    ref_ok() { [[ "$1" =~ ^[A-Za-z0-9._/-]{1,100}$ ]]; }
    if [[ -n "$branch" ]] && ! ref_ok "$branch"; then
      echo "invalid branch: $branch" >&2; exit 2
    fi
    if [[ -n "$commit" ]] && ! ref_ok "$commit"; then
      echo "invalid commit: $commit" >&2; exit 2
    fi

    # Refuse to stack updates. --collect cleans the unit up when it finishes.
    if systemctl is-active --quiet "$UNIT.service"; then
      echo "update already running"
      exit 0
    fi

    : > "$LOG_FILE"; chmod 0644 "$LOG_FILE"
    echo running > "$STATE_FILE"; chmod 0644 "$STATE_FILE"

    # Snapshot ourselves and run the snapshot (the reinstall replaces the
    # installed path during the update).
    install -m 0755 "$0" "$RUN_COPY"

    # /run is mounted noexec, so systemd can't EXEC the snapshot directly;
    # invoke it THROUGH bash (reading a script under noexec is allowed).
    systemd-run \
      --unit="$UNIT" \
      --collect \
      --setenv=STACKPI_DISPLAY_REPO_DIR="$REPO_DIR" \
      --setenv=STACKPI_DISPLAY_USER="$KIOSK_USER" \
      --setenv=STACKPI_BRANCH="$branch" \
      --setenv=STACKPI_COMMIT="$commit" \
      /bin/bash "$RUN_COPY" run
    echo "update started"
    ;;

  run)
    install -d -m 0755 "$STATE_DIR"
    echo running > "$STATE_FILE"; chmod 0644 "$STATE_FILE"

    {
      echo ">>> StackPI display update starting $(date -Is)"
      echo ">>> repo: $REPO_DIR  branch: ${STACKPI_BRANCH:-<current>}  commit: ${STACKPI_COMMIT:-<tip>}"
      if STACKPI_DISPLAY_MODE=update \
          TARGET_DIR="$REPO_DIR" \
          KIOSK_USER="$KIOSK_USER" \
          TARGET_BRANCH="${STACKPI_BRANCH:-}" \
          TARGET_COMMIT="${STACKPI_COMMIT:-}" \
          bash "$REPO_DIR/display/bootstrap.sh"; then
        echo ">>> update succeeded"
        echo success > "$STATE_FILE"; chmod 0644 "$STATE_FILE"
      else
        rc=$?
        echo ">>> update FAILED (exit $rc)"
        echo failed > "$STATE_FILE"; chmod 0644 "$STATE_FILE"
        exit "$rc"
      fi
    } >> "$LOG_FILE" 2>&1
    ;;

  *)
    echo "stackpi-display-update: unknown subcommand: $cmd" >&2
    exit 2
    ;;
esac
