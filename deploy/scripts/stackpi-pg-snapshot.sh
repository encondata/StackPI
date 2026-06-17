#!/usr/bin/env bash
# StackPI Postgres snapshot — runs every 5 minutes via timer. Dumps the
# stackpi database to USB and rotates older dumps. Custom format (-Fc) is
# faster to restore than plain SQL and is what stackpi-pg-bootstrap.sh
# expects to find.

set -euo pipefail

SNAP_DIR=/mnt/stackpi-data
KEEP=12   # 12 snapshots × 5 min = ~1 hour of history

mkdir -p "$SNAP_DIR"

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$SNAP_DIR/stackpi-${TS}.dump"
TMP="${OUT}.partial"

sudo -u postgres pg_dump -d stackpi -Fc -f "$TMP"
sync
mv "$TMP" "$OUT"

# Rotation: keep only the most recent KEEP dumps.
ls -1t "$SNAP_DIR"/stackpi-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

# Quick smoke: surface size so journalctl shows progress.
SIZE=$(stat -c %s "$OUT" 2>/dev/null || echo 0)
echo "[stackpi-pg-snapshot] wrote $OUT (${SIZE} bytes); kept $KEEP newest."
