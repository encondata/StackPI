# display

The **StackPI remote status display** — a slim Raspberry Pi (Pi 3+ class) on a
monitor that shows the primary StackPI's `/status` and `/trucks` screens, fed
over UDP multicast. No Postgres, no FastAPI, no portal runtime on the device.

## Install (one-liner, on a fresh Pi as user `csg`)

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/StackPI/dev/display/bootstrap.sh | bash
```

`bootstrap.sh` installs chromium + sway, builds a **static export** of the
portal's kiosk pages once (Node is installed only for this build), installs the
receiver + config + systemd units + sway kiosk, and reboots into the display.

## How it works

```
primary StackPI ──UDP multicast status snapshot (5s + on-change)──▶
  display Pi:  receiver.py  (joins the group, holds the latest snapshot,
                             serves the exported pages + EMULATES the /local/*
                             endpoints + SSE the pages call, from the snapshot)
               → chromium kiosk → http://localhost:8080/status
```

The portal `/status` + `/trucks` pages run **unchanged** — same-origin to the
receiver, which answers their `/local/*` requests from the snapshot. The browser
never talks to the primary.

## Files

| file | role |
|---|---|
| `receiver.py` | multicast listener + localhost HTTP (static export + emulated endpoints + SSE) |
| `bootstrap.sh` | slim installer (the one-liner) |
| `config.example.json` | → `/etc/stackpi-display/config.json` (group/port/http_port/web_dir/screen) |
| `stackpi-display.service` | the receiver |
| `stackpi-display-kiosk.service` + `sway-display.conf` + `display-kiosk-launch.sh` | the kiosk |
| `status-protocol.md` | the shared wire spec (also used by the primary sender) |

## Config

`/etc/stackpi-display/config.json` — set `multicast_group`/`multicast_port` to
match the primary's **Status broadcast** settings, `screen` to `status` or
`trucks`, and `http_port` if needed. Restart `stackpi-display` after edits.
Wi-Fi is set up with `nmcli` (a small web `/config` is a planned follow-up).

## First-cut notes (validate on the Pi)

- The **Next static export** of the portal is built on the Pi during bootstrap;
  if any route isn't export-compatible the build will say so — that's the main
  thing to confirm on real hardware.
- Endpoint **emulation** is best-effort: metrics/reader/registration/activity/
  events come from the snapshot; settings-driven cosmetics fall back to
  defaults. Live activity currently renders the snapshot's recent items (richer
  live-append over SSE is a follow-up).
