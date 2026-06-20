#!/usr/bin/env bash
# Launch the two chromium kiosk windows for the StackPI dual-display setup.
# Called by sway's `exec` directive (see sway-kiosk.conf).
set -e

CHROMIUM=/usr/bin/chromium

COMMON_ARGS=(
  --kiosk
  --noerrdialogs
  --disable-infobars
  --disable-pinch
  --no-first-run
  --disable-component-extensions-with-background-pages
  --check-for-update-interval=31536000
  --ozone-platform=wayland
)

# PITFT50 — workspace 1. The root route shows the logo (or the pairing QR
# if the device isn't registered yet); /config remains reachable from the
# admin portal at http://<pi-ip>/config in any browser on the LAN.
"$CHROMIUM" "${COMMON_ARGS[@]}" \
  --class=stackpi-config \
  --user-data-dir=/tmp/stackpi-chromium-config \
  http://localhost/ &

# Info screen — pinned to workspace 2 (HDMI monitor). The /screens/info1
# wrapper polls /local/screens/info1 and swaps an embedded iframe to whatever
# the selector says (clock / status / trucks / cycle / off). Chromium itself
# never has to be restarted to change views.
#
# Only spawn it when its HDMI output (HDMI-A-1) is actually connected — same
# reasoning as info2 below. On a touchscreen-only Pi (no HDMI) workspace 2
# falls back onto DSI-1, so this window maps over the PITFT; sway then drops
# the config window out of fullscreen to reveal the newcomer, leaving the
# touchscreen showing chromium's toolbar. Gating it keeps the PITFT fullscreen.
if swaymsg -t get_outputs 2>/dev/null | grep -q "HDMI-A-1"; then
  "$CHROMIUM" "${COMMON_ARGS[@]}" \
    --class=stackpi-info \
    --user-data-dir=/tmp/stackpi-chromium-info \
    http://localhost/screens/info1 &
fi

# Second info screen — only when a second HDMI output (HDMI-A-2) is actually
# connected. Spawning it unconditionally would land the fullscreen window on a
# fallback output (e.g. the touchscreen) and hide the menu, so we gate on the
# live output list. Pinned to workspace 3 (HDMI-A-2) via sway-kiosk.conf.
if swaymsg -t get_outputs 2>/dev/null | grep -q "HDMI-A-2"; then
  "$CHROMIUM" "${COMMON_ARGS[@]}" \
    --class=stackpi-info2 \
    --user-data-dir=/tmp/stackpi-chromium-info2 \
    http://localhost/screens/info2 &
fi

# Keep the PITFT (config) window fullscreen for the life of the session. The
# for_window rule fullscreens it, but a new window (the HDMI info screen) maps on
# the touchscreen's focused workspace and sway drops config out of fullscreen
# before that window moves to its own output — leaving the touchscreen showing
# chromium's toolbar. The timing is unpredictable (at cold boot chromium maps
# long after launch), so rather than re-assert for a fixed window, subscribe to
# sway's window events and re-fullscreen config whenever something changes.
# `fullscreen enable` is idempotent: a no-op when config is already fullscreen,
# so asserting it doesn't trigger an event and loop on itself.
(
  swaymsg '[app_id="stackpi-config"] fullscreen enable' >/dev/null 2>&1 || true
  swaymsg -t subscribe -m '["window"]' 2>/dev/null | while read -r _event; do
    swaymsg '[app_id="stackpi-config"] fullscreen enable' >/dev/null 2>&1 || true
  done
) &

wait
