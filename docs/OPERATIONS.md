# StackPI — Operations & Usage Guide

How to install, set up, use, and maintain a StackPI device. For how the system
is built, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Requirements

- **Raspberry Pi 5** running Raspberry Pi OS (Debian 13 / Trixie tested,
  Postgres 17).
- A user named **`csg`** with `sudo` (the systemd units are pinned to this
  user and to `/home/csg/StackPI_v2`).
- A **USB drive** plugged in at `/dev/sda1` — used for database snapshots
  (the install reads its UUID for an `/etc/fstab` entry).
- RFID hardware: one or more **Zebra FX9600** readers with the IoT Connector
  configured to POST tag reads to the Pi's `http://<pi>/rfid-tags`.
- One or two displays (the DSI touchscreen is the interactive one; HDMI is a
  secondary info display).

---

## 2. Install (fresh Pi)

Provision a fresh Pi end-to-end with one command, run **as `csg`** with the USB
drive attached:

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/StackPI/main/deploy/bootstrap.sh | bash
```

It performs the full chain and then reboots into the kiosk:

1. installs `git`
2. clones the repo into `/home/csg/StackPI_v2`
3. **`install.sh`** — system packages, Node 20 (NodeSource), pgweb
4. **`setup-pg-memcluster.sh`** — RAM Postgres cluster + USB snapshot mounts/services
5. **`deploy.sh`** — builds api/engine/portal, installs systemd units, applies migrations
6. **`setup-kiosk.sh`** — display groups, `multi-user.target`, disables the desktop display manager, enables the kiosk
7. **reboots** (10s cancellable countdown)

Environment overrides: `REPO_URL`, `BRANCH`, `TARGET_DIR`, `SKIP_DB=1`,
`SKIP_KIOSK=1`, `SKIP_REBOOT=1`.

> No manual commands are required. SSH stays available throughout (only the
> graphical desktop is disabled, not networking).

---

## 3. First-run setup

### 3a. Register the device with the cloud
On first boot the device pairs with BaseCampV2. The engine requests a pairing
token and waits; an operator approves the device in the BaseCampV2 portal.
Until approved, the status bar shows **Un-Registered**; once approved it shows
**Registered**. Registration/token state lives in `/var/lib/stackpi/state.json`
and is owned entirely by the engine.

### 3b. Run the Initial Setup wizard (touchscreen)
From the home screen tap **Initial Setup**:

1. **Select Move** — pick the active move (with a Sync button).
2. **RFID Reader** — select a reachable reader, or add one by IP + password
   (its name is read from the reader's hostname).
3. **Site & Scan Type** — choose source/destination site and scan type;
   tapping **Next** commits these to the portal.
4. **Confirm** — a summary that turns each item green as it succeeds.

The reader chosen here becomes the device's **active reader** (used by the home
RFID Reader card).

---

## 4. Using the touchscreen (800×480)

The home screen (`/`) is a 2×2 menu plus a status bar (time, host, portal
registration). The four cards:

- **Initial Setup** — the wizard above.
- **Config** — opens the touchscreen Config (see below).
- **Internet** — WiFi + wired (DHCP/static) network configuration with an
  on-screen keyboard. Shown automatically if the device is unregistered and
  offline.
- **RFID Reader** — a live stoplight for the active reader
  (**Reading** / **Online** / **Degraded** / **Offline** / **Not set up**,
  colored like `/status`). **Tap it to start/stop reading**; a full-screen
  flash confirms. While reading, the card's border runs the same animation as
  the `/status` change-border effect.

### Config panels (`/device-config`)
- **Screens** — assign each output (HDMI 1, HDMI 2, Touchscreen) a view:
  Clock / Status / Truck / **Cycle**.
- **Audio** — notification volume + sound, with a Test button.
- **Timers** — the screen-cycle interval (seconds) and the RFID polling
  refresh (minutes).
- **Update** — placeholder for a future git-pull/reinstall button.

> The touchscreen never navigates into the desktop `/config/*` admin.

---

## 5. The admin portal (`/config/*`, over LAN)

From any browser on the LAN, open `http://<pi-ip>/config` for the full admin:

- **Settings** — system (hostname, time, NTP, device-status interval),
  hardware, network, screen settings, and screen-status (the `/status`
  change-border animation: style, color, width, cycles).
- **RFID** — reader management (add/edit/delete, subnet scan, probe, status
  poll), settings (polling interval, show-unmatched toggle, **bad-tag alerts**:
  sound/volume/debounce), and match logs.
- **Registration** — device pairing status.
- **Portal Data → Cloud Sync** — sync status with BaseCampV2.
- **Database / Logs** — housekeeping and upload-queue status.

A read-only DB browser (pgweb) is also available at `http://<pi-ip>:8081`.

---

## 6. Bad-tag alerts

When a scanned tag is a known asset that is **not part of the active move**,
the device immediately: plays the configured sound, flashes the operator
screens red/yellow with the **serial number + RFID tag**, and logs a System
Event. Configure the sound, volume, and per-tag debounce under
**/config → RFID → Settings → Bad-Tag Alerts** (or the touchscreen **Audio**
panel for sound/volume). The alert only fires on a *new* scan — refreshing a
page or restarting a service never replays an old alert.

---

## 7. Updating an existing device

Either re-run the one-liner (it fast-forwards the checkout and re-applies
everything idempotently):

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/StackPI/main/deploy/bootstrap.sh | bash
```

…or, for a code/app update without re-touching the OS/DB/kiosk setup:

```bash
cd ~/StackPI_v2 && git pull --ff-only && bash deploy/deploy.sh
```

`deploy.sh` rebuilds the API venv, engine venv, and portal (`npm ci && npm run
build`), reinstalls units, re-applies migrations, reinstalls kiosk assets, and
restarts services.

---

## 8. Database & snapshots

- The live database is in RAM (tmpfs) and is **rebuilt on every boot** by
  `stackpi-pg-bootstrap`, which restores the newest USB snapshot if one exists.
- Snapshots are written to the USB at `/mnt/stackpi-data` by
  `stackpi-pg-snapshot.timer` (`pg_dump`).
- **Implication:** a reboot without a recent snapshot loses since-snapshot
  local data. Keep the USB drive attached. Cloud-synced data is re-pulled from
  BaseCampV2 regardless.
- Manual snapshot: `sudo /usr/local/sbin/stackpi-pg-snapshot.sh`.

---

## 9. Service reference

```bash
# status / restart any service
sudo systemctl status  stackpi-api stackpi-engine stackpi-portal
sudo systemctl restart stackpi-portal

# logs (follow)
journalctl -u stackpi-api -f
journalctl -u stackpi-kiosk -b      # current boot, kiosk display
journalctl -u stackpi-engine -f     # registration/heartbeat
```

| Service | Role |
|---------|------|
| `stackpi-portal` | Next.js UI on :80 |
| `stackpi-api` | FastAPI `/local/*` + `/rfid-tags` on :8000 |
| `stackpi-engine` | cloud registration + heartbeat |
| `stackpi-postgresql` / `stackpi-pg-bootstrap` | RAM DB + per-boot init/restore |
| `stackpi-pg-snapshot.timer` | USB snapshots |
| `stackpi-rfid-poll.timer` | reader status polling |
| `stackpi-scan-upload.timer` | push scans to cloud |
| `stackpi-pgweb` | DB browser on :8081 |
| `stackpi-kiosk` | sway + chromium on the displays |

---

## 10. Troubleshooting

**Kiosk screens are blank / sway won't start.** Confirm the desktop display
manager is gone and the user has display groups:
```bash
systemctl get-default            # should be multi-user.target
systemctl is-active lightdm      # should be inactive/not-found
groups csg                       # should include video input render tty
journalctl -u stackpi-kiosk -b --no-pager | tail -40
```
Re-running `sudo bash ~/StackPI_v2/deploy/scripts/setup-kiosk.sh` fixes all of
these and re-enables the kiosk.

**Database / "stackpi does not exist".** Check the bootstrap and that the USB
mounted:
```bash
journalctl -u stackpi-pg-bootstrap -b --no-pager | tail -40
findmnt /var/lib/postgresql-mem /mnt/stackpi-data
```
Re-run `sudo bash ~/StackPI_v2/deploy/scripts/setup-pg-memcluster.sh` (needs the
USB at `/dev/sda1`).

**Reader unreachable / start/stop fails.** Verify the reader is reachable and
credentials are right via **/config → RFID → Readers** (use *Probe* / *Poll
status*). Reader calls go over HTTPS with self-signed certs on the LAN.

**Device stuck Un-Registered.** Check `journalctl -u stackpi-engine -f` and
approve the device in BaseCampV2. Token state is in
`/var/lib/stackpi/state.json`.

**Tags arriving but no matches.** Ensure a Sync has run (synced data populates
the match tables) and the active move is set. Check the upload queue under
**/config → Logs**.
