# StackPI

StackPI is a **Raspberry Pi 5 appliance for tracking datacenter asset movement
via RFID**. Zebra RFID readers stream tag reads to the Pi; the Pi matches them
against assets/people synced from a cloud portal (**BaseCampV2**), shows live
status on attached displays and an interactive touchscreen, raises alerts for
tags that don't belong to the active move, and reconciles everything with the
cloud — continuing to work when the network is down.

It runs as native `systemd` services (FastAPI API, a Python cloud agent, a
Next.js portal, and a RAM-backed PostgreSQL with USB snapshots) and boots
straight into a `sway` + chromium kiosk.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how it's built: components,
  data flow, the RFID pipeline, cloud sync, the kiosk display model.
- **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — how to install, set up, use,
  update, and troubleshoot a device.

## Setup (fresh Raspberry Pi)

Provision a fresh Pi from scratch with one command. Run it **as the `csg` user**
(it uses `sudo` where root is needed), with the USB snapshot drive plugged in at
`/dev/sda1`:

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/StackPI/main/deploy/bootstrap.sh | bash
```

The [`deploy/bootstrap.sh`](deploy/bootstrap.sh) script:

1. Installs `git`
2. Clones the repo into `/home/csg/StackPI_v2`
3. Runs [`deploy/install.sh`](deploy/install.sh) — system packages + Node 20 (NodeSource) + pgweb
4. Runs [`deploy/scripts/setup-pg-memcluster.sh`](deploy/scripts/setup-pg-memcluster.sh) — RAM Postgres cluster + USB snapshots
5. Runs [`deploy/deploy.sh`](deploy/deploy.sh) — builds API/engine/portal, installs `systemd` units, applies migrations
6. Runs [`deploy/scripts/setup-kiosk.sh`](deploy/scripts/setup-kiosk.sh) — display-group setup, switches to `multi-user.target`, disables the desktop display manager, and enables the sway kiosk

No manual commands are required. When it finishes it **reboots automatically**
(after a 10-second cancellable countdown) for a clean first start of the kiosk
display. Pass `SKIP_REBOOT=1` to skip that.

**Requirements:** the Pi user must be `csg`, and the USB snapshot drive must be
present at `/dev/sda1`.

**Options (env vars):** `REPO_URL`, `BRANCH`, `TARGET_DIR`, `SKIP_DB=1` (skip the
database step for a dry run without the USB), `SKIP_KIOSK=1` (skip the display
setup), and `SKIP_REBOOT=1` (don't reboot at the end).

**Updating an already-provisioned Pi:** re-run the same one-liner (it
fast-forwards the checkout), or just `bash ~/StackPI_v2/deploy/deploy.sh`.

## What it does

- **RFID ingest + matching** — Zebra readers POST to `/rfid-tags`; reads are
  matched inline against synced assets/people.
- **Bad-tag alerts** — a tag that's a known asset but not in the active move
  triggers an instant sound + full-screen flash (serial + tag) + logged event.
- **Live displays** — a `/status` dashboard (metrics, RFID activity, system
  events, RFID traffic light) and a `/trucks` map view, assignable per HDMI
  output, with a Status↔Truck cycle mode.
- **Touchscreen UI** — home menu, Initial Setup wizard, network config, and a
  Config surface (Screens / Audio / Timers / Update), plus a tap-to-start/stop
  RFID Reader card.
- **Cloud sync** — pulls moves/assets/people/asset-tags from BaseCampV2 and
  uploads processed scans; 3-state device status (Registered / Offline /
  Un-Registered).
- **Resilient data** — RAM Postgres for speed, USB snapshots for durability.

## Tech stack

- **API:** FastAPI + Pydantic (Postgres via `psql`/trust-auth, no ORM)
- **Engine:** Python registration/heartbeat daemon (file-based state)
- **Portal:** Next.js 16 + React 19 + Tailwind + GSAP
- **Data:** PostgreSQL 17 (tmpfs cluster, USB `pg_dump` snapshots)
- **Kiosk:** sway (Wayland) + chromium, multi-output
- **Ops:** native `systemd` services + timers; provisioned from scripts in `deploy/`

## Repository layout

```text
api/      FastAPI app + tests        — device-local HTTP API
engine/   cloud registration/heartbeat agent
portal/   Next.js portal (kiosk pages + admin /config)
db/sql/   idempotent SQL migrations
deploy/   bootstrap/install/deploy scripts, systemd units, sway, plymouth, assets
scripts/  local dev + test-deploy helpers
docs/     architecture + operations documentation
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full component map and
[docs/OPERATIONS.md](docs/OPERATIONS.md) for day-to-day operation.
