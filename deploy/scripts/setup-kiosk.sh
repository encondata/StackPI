#!/usr/bin/env bash
set -euo pipefail

# One-time kiosk display prep — makes the Pi boot into the StackPI kiosk
# (sway + chromium) instead of the desktop, and grants the kiosk user the
# device-access groups sway needs to become DRM master / read input.
#
# Fully idempotent. Run as root:  sudo bash deploy/scripts/setup-kiosk.sh
#
# Why each step:
#   - groups video/input/render/tty: sway needs DRM (video/render), libinput
#     (input), and the tty.
#   - multi-user.target + no display manager: a running display manager
#     (lightdm/gdm/sddm) holds the GPU, so sway exits 1 ("can't become DRM
#     master"). We boot to multi-user and let the kiosk unit own tty1.

KIOSK_USER="${KIOSK_USER:-csg}"

info()  { printf '\n\033[1;34m>>> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }
warn()  { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo bash deploy/scripts/setup-kiosk.sh)" >&2
  exit 1
fi

info "Granting '$KIOSK_USER' the display/input groups"
usermod -aG video,input,render,tty "$KIOSK_USER"
ok "groups: $(id -nG "$KIOSK_USER")"

info "Switching boot to multi-user.target (no desktop) + disabling display manager"
systemctl set-default multi-user.target >/dev/null
# Stop/disable whatever display manager the image shipped with. display-manager
# is the generic alias; the named ones cover common images. Missing units just
# no-op. A running DM holds DRM and blocks sway.
for dm in display-manager lightdm gdm3 gdm sddm; do
  systemctl disable --now "${dm}.service" 2>/dev/null || true
done
ok "Desktop display manager disabled; default target = multi-user"

info "Enabling + starting the kiosk"
# Clear any prior crash-loop start-limit so the restart isn't refused.
systemctl reset-failed stackpi-kiosk.service 2>/dev/null || true
systemctl enable stackpi-kiosk.service >/dev/null
if systemctl restart stackpi-kiosk.service; then
  ok "stackpi-kiosk enabled + started"
else
  warn "stackpi-kiosk enabled but did not start cleanly yet — it will retry on"
  warn "boot. Check: journalctl -u stackpi-kiosk -b"
fi

info "Kiosk setup complete (a reboot gives the cleanest first start)"
