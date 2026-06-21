#!/usr/bin/env bash
# Launch the chromium kiosk for the status display, pointed at the local
# receiver. Which screen + port come from /etc/stackpi-display/config.json.
set -e

CHROMIUM=/usr/bin/chromium
CFG=/etc/stackpi-display/config.json
SCREEN="$(python3 -c "import json;print(json.load(open('$CFG')).get('screen','status'))" 2>/dev/null || echo status)"
PORT="$(python3 -c "import json;print(json.load(open('$CFG')).get('http_port',8080))" 2>/dev/null || echo 8080)"

# --disable-gpu --no-sandbox are REQUIRED on the Pi 3 (and harmless elsewhere):
#   * Without --no-sandbox chromium never maps a Wayland window at all (blank).
#   * The Pi 3's VC4 GPU can't give chromium the GLES 3.0 context it requests
#     via ANGLE — the GPU process crash-loops; --disable-gpu uses software
#     rendering instead (slow first paint, ~20-30s on a Pi 3, but it works).
# Use 127.0.0.1, not localhost: localhost resolves to ::1 (IPv6) first and the
# receiver only listens on IPv4, so chromium would fail to connect.
"$CHROMIUM" \
  --kiosk --noerrdialogs --disable-gpu --no-sandbox --disable-infobars \
  --disable-pinch --no-first-run \
  --check-for-update-interval=31536000 --ozone-platform=wayland \
  --class=stackpi-display \
  --user-data-dir=/tmp/stackpi-display-chromium \
  "http://127.0.0.1:${PORT}/${SCREEN}" &

# Keep the window fullscreen. A re-layout (or a slow cold-boot map) can drop it
# out of fullscreen; re-assert on every sway window event (idempotent), the same
# fix the primary kiosk uses.
(
  swaymsg '[app_id="stackpi-display"] fullscreen enable' >/dev/null 2>&1 || true
  swaymsg -t subscribe -m '["window"]' 2>/dev/null | while read -r _event; do
    swaymsg '[app_id="stackpi-display"] fullscreen enable' >/dev/null 2>&1 || true
  done
) &

wait
