#!/usr/bin/env bash
# StackPI Postgres bootstrap — runs as a oneshot before stackpi-postgresql.service.
#
# On a fresh tmpfs (after every reboot, since RAM is volatile) this does:
#   1. initdb on the tmpfs data directory
#   2. configure postgresql.conf and pg_hba.conf for trust-auth local-only
#   3. briefly start postgres to create the csg user and stackpi database
#   4. pg_restore the latest snapshot from USB if one exists
#   5. stop postgres so the long-running stackpi-postgresql.service can own it
#
# On a tmpfs that's already initialized this is a fast no-op.
#
# stdout/stderr go to the systemd journal (journalctl -u stackpi-pg-bootstrap).
# Only pg_ctl needs a file (background postgres log) — that goes to
# /var/lib/postgresql/stackpi-bootstrap.log (postgres's home dir, owned by
# postgres, persists across boots).

set -euo pipefail

DATA=/var/lib/postgresql-mem
SNAP_DIR=/mnt/stackpi-data
PG_BIN=/usr/lib/postgresql/17/bin
PGCTL_LOG=/var/lib/postgresql/stackpi-bootstrap.log

log() { printf '[stackpi-pg-bootstrap] %s\n' "$1"; }

# Ensure the tmpfs data dir exists and is owned by postgres. The fstab mount
# option sets this on mount, but be defensive in case of an override. tmpfs
# supports chown/chmod, so install -d is fine here.
install -d -o postgres -g postgres -m 0700 "$DATA"
# The USB snapshot dir is a vfat mount — ownership and permissions are fixed by
# the fstab uid/gid/umask at mount time and CANNOT be changed with chown/chmod
# (that errors "Operation not permitted" on vfat). Just ensure it exists.
mkdir -p "$SNAP_DIR"

# Pre-create the pg_ctl log file with postgres ownership so pg_ctl (running
# as postgres) can open it for write. /var/lib/postgresql is postgres's home,
# guaranteed writable by postgres.
install -m 0644 -o postgres -g postgres /dev/null "$PGCTL_LOG"

if [[ -f "$DATA/PG_VERSION" ]]; then
  log "Cluster already initialized at $DATA; skipping bootstrap."
  exit 0
fi

log "Fresh tmpfs detected; running initdb."
sudo -u postgres "$PG_BIN/initdb" \
  -D "$DATA" \
  --auth-local=trust \
  --auth-host=trust \
  --no-instructions

# Lock down listening + tune for memory-only workload.
sudo -u postgres tee -a "$DATA/postgresql.conf" >/dev/null <<'EOF'

# --- StackPI overrides (set by stackpi-pg-bootstrap.sh) ---
listen_addresses = '127.0.0.1'
port = 5432
unix_socket_directories = '/var/run/postgresql'
# Cluster lives entirely in tmpfs; fsync isn't durable anyway and adds
# write amplification. Snapshots to USB provide our durability boundary.
fsync = off
synchronous_commit = off
full_page_writes = off
EOF

log "Starting postgres temporarily for bootstrap."
sudo -u postgres "$PG_BIN/pg_ctl" \
  -D "$DATA" \
  -l "$PGCTL_LOG" \
  -w -t 30 \
  start

cleanup() {
  log "Stopping bootstrap postgres."
  sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -w -t 30 stop || true
}
trap cleanup EXIT

log "Creating csg user + stackpi database."
sudo -u postgres psql -v ON_ERROR_STOP=0 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'csg') THEN
    CREATE ROLE csg WITH LOGIN PASSWORD 'csg' SUPERUSER;
  END IF;
END $$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='stackpi'" \
  | grep -q 1 \
  || sudo -u postgres createdb -O csg stackpi

LATEST=$(ls -1t "$SNAP_DIR"/stackpi-*.dump 2>/dev/null | head -1 || true)
if [[ -n "${LATEST:-}" && -s "$LATEST" ]]; then
  log "Restoring stackpi from snapshot: $LATEST"
  sudo -u postgres pg_restore \
    -d stackpi \
    --clean --if-exists --no-owner \
    "$LATEST" \
    || log "pg_restore reported warnings (often safe — full log: $PGCTL_LOG)."
else
  log "No snapshot found in $SNAP_DIR; starting with an empty stackpi DB."
fi

# Apply any SQL migration files. Each file is expected to be idempotent
# (IF NOT EXISTS, etc.) so this runs safely on every boot — even after a
# restore that already contains some tables.
SQL_DIR=/home/csg/StackPI_v2/db/sql
if [[ -d "$SQL_DIR" ]]; then
  shopt -s nullglob
  for sql in "$SQL_DIR"/*.sql; do
    log "Applying $(basename "$sql")"
    # Pipe via stdin: the shell (root) reads the file, postgres just reads
    # stdin. Direct `-f path` fails because /home/csg is 0700 and the
    # postgres user can't traverse into it to open the file.
    sudo -u postgres psql -d stackpi -v ON_ERROR_STOP=1 < "$sql" \
      || log "WARNING: $(basename "$sql") returned non-zero (continuing)."
  done
  shopt -u nullglob
fi

log "Bootstrap complete."
