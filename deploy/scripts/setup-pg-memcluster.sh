#!/usr/bin/env bash
# One-time Pi-side setup for the in-memory Postgres cluster + USB snapshot.
#
# Run this once per Pi, after rsync'ing the repo. It is idempotent — running
# again just confirms the existing state is correct.
#
# Usage:  sudo bash deploy/scripts/setup-pg-memcluster.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMPFS_DIR=/var/lib/postgresql-mem
USB_MOUNT=/mnt/stackpi-data
TMPFS_SIZE=1g

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo bash ...)" >&2; exit 1
fi

info()  { printf '\n\033[1;34m>>> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }

info "Disabling Debian-managed postgresql.service"
systemctl stop postgresql.service postgresql@17-main.service 2>/dev/null || true
systemctl disable postgresql.service postgresql@17-main.service 2>/dev/null || true
ok "Debian postgresql stopped + disabled"

info "Preparing mount points"
mkdir -p "$TMPFS_DIR" "$USB_MOUNT"
chown postgres:postgres "$TMPFS_DIR" "$USB_MOUNT"
chmod 0700 "$TMPFS_DIR" "$USB_MOUNT"
ok "Mount points ready"

PG_UID=$(id -u postgres)
PG_GID=$(id -g postgres)

info "Adding fstab entries (tmpfs + USB)"
# Use the USB partition's UUID for stability across reboots/reflashes.
USB_DEV=/dev/sda1
USB_UUID=$(blkid -s UUID -o value "$USB_DEV" 2>/dev/null || true)
if [[ -z "$USB_UUID" ]]; then
  echo "Could not read UUID from $USB_DEV — is the USB drive plugged in?" >&2
  exit 1
fi

TMPFS_LINE="tmpfs $TMPFS_DIR tmpfs nodev,nosuid,size=${TMPFS_SIZE},uid=${PG_UID},gid=${PG_GID},mode=0700 0 0"
USB_LINE="UUID=${USB_UUID} ${USB_MOUNT} vfat defaults,uid=${PG_UID},gid=${PG_GID},umask=0077,nofail 0 0"

grep -qE "^[^#]*${TMPFS_DIR}" /etc/fstab || echo "$TMPFS_LINE" >> /etc/fstab
grep -qE "^[^#]*${USB_MOUNT}"  /etc/fstab || echo "$USB_LINE"   >> /etc/fstab

systemctl daemon-reload
mount -a
ok "Mounts present: $(findmnt -n "$TMPFS_DIR" | awk '{print $1}'), $(findmnt -n "$USB_MOUNT" | awk '{print $1}')"

info "Installing scripts to /usr/local/sbin"
install -m 0755 "$REPO_DIR/deploy/scripts/stackpi-pg-bootstrap.sh" /usr/local/sbin/
install -m 0755 "$REPO_DIR/deploy/scripts/stackpi-pg-snapshot.sh"  /usr/local/sbin/
ok "Scripts installed"

info "Installing systemd units"
install -m 0644 "$REPO_DIR/deploy/services/stackpi-pg-bootstrap.service" /etc/systemd/system/
install -m 0644 "$REPO_DIR/deploy/services/stackpi-postgresql.service"   /etc/systemd/system/
install -m 0644 "$REPO_DIR/deploy/services/stackpi-pg-snapshot.service"  /etc/systemd/system/
install -m 0644 "$REPO_DIR/deploy/services/stackpi-pg-snapshot.timer"    /etc/systemd/system/
systemctl daemon-reload
ok "Units loaded"

info "Enabling + starting stackpi-postgresql + snapshot timer"
systemctl enable --now stackpi-pg-bootstrap.service
systemctl enable --now stackpi-postgresql.service
systemctl enable --now stackpi-pg-snapshot.timer
ok "Services up"

info "Sanity check"
sudo -u postgres psql -d stackpi -c "SELECT current_database(), current_user, version();" || true

info "Setup complete"
