# StackPI — Architecture

StackPI is a Raspberry Pi 5 appliance that tracks the physical movement of
datacenter assets (servers, network gear) via RFID, shows live status on
attached displays + a touchscreen, and syncs with a cloud portal
(**BaseCampV2**) that owns the moves, assets, and people. The Pi keeps working
when the network is down and reconciles with the cloud when it returns.

This document describes how the system is built. For installing and operating
it, see [OPERATIONS.md](OPERATIONS.md).

---

## 1. Component map

```
                          ┌──────────────────────────────────────────┐
   RFID readers           │            Raspberry Pi 5 (kiosk)         │
   (Zebra FX9600,         │                                            │
    Zebra IoT Connector)  │   portal (Next.js)   :80                   │
        │  POST /rfid-tags │     ├─ kiosk pages  (/, /status, …)       │
        └─────────────────►│     └─ admin /config/*                    │
                          │          │  proxies /local/* ──┐           │
                          │          ▼                     ▼           │
                          │   sway + chromium        api (FastAPI) :8000│
                          │   (multi-output kiosk)        │            │
                          │                               ▼            │
                          │                   PostgreSQL 17 (tmpfs)    │
                          │                   :5432  "stackpi"         │
                          │                          │  USB snapshots  │
                          │   engine (Python agent)  │  /mnt/stackpi-  │
                          │     registration +       │      data       │
                          │     heartbeat ───────────┼──────┐          │
                          └──────────────────────────┼──────┼──────────┘
                                                     │      │
                                                     ▼      ▼
                                          BaseCampV2 cloud (api.serversherpa.com)
                                          /stackpi/*  (device Bearer token)
```

Five long-running services plus the database and the kiosk session:

| Service (`systemd`)        | What it is                                              | Port |
|----------------------------|---------------------------------------------------------|------|
| `stackpi-portal`           | Next.js portal (kiosk pages + admin UI)                 | 80   |
| `stackpi-api`              | FastAPI app — all `/local/*` endpoints + `/rfid-tags`   | 8000 |
| `stackpi-engine`           | Python agent — cloud registration + heartbeat           | —    |
| `stackpi-postgresql`       | RAM-backed Postgres 17 cluster                          | 5432 |
| `stackpi-pgweb`            | pgweb DB browser (LAN admin convenience)                | 8081 |
| `stackpi-kiosk`            | sway compositor + chromium on the displays              | —    |

Plus oneshots/timers: `stackpi-pg-bootstrap` (initdb + restore on boot),
`stackpi-pg-snapshot.timer` (USB snapshots), `stackpi-rfid-poll.timer`
(reader status polling), `stackpi-scan-upload.timer` (push scans to cloud).

---

## 2. The three application tiers

### API — `api/` (FastAPI, port 8000)
Owns all device-local HTTP. Routers (see `api/app/main.py`):

- `local` — device status, metrics, hostname/network, active move/event selection, deregister.
- `settings` — system settings (hostname/time/NTP), hardware, network config, screen-status (the `/status` animation), all stored in the `local_app_settings` key/value table.
- `rfid` — reader CRUD, subnet scan/probe, login + `/cloud` status/start/stop/mode, the **active-reader** endpoint, RFID settings, and SSE streams (`/local/rfid/matches/stream`, `/local/rfid/scans/stream`).
- `rfid_ingest` — **`POST /rfid-tags`** (no prefix): the endpoint Zebra's IoT Connector POSTs raw reads to.
- `screens` — per-output screen assignment + the screen-cycle interval.
- `portal_data` + `system_events` — cloud-sync status views and the System Events SSE feed (`/local/system-events/stream`).
- `setup` — Initial Setup wizard proxies to BaseCampV2 (`/local/setup/*`).
- `alerts` — bad-tag alert config + sound test (`/local/alerts/*`).
- `db` — local DB housekeeping (clear raw scans).

**Data access convention:** the API talks to Postgres by shelling out to `psql`
over the local trust-auth socket (parameterised via `psql -v` / `:'name'`), not
through an ORM. This keeps the API dependency-light and matches the
trust-auth, localhost-only cluster. There is no SQLAlchemy/Alembic.

### Engine — `engine/` (Python daemon)
A long-running agent (`engine/app/agent.py`) that owns the device's
relationship with the cloud:

- **Registration** — `/register/init` → poll `/register/poll` until the
  operator approves the device in BaseCampV2, then persists the access/refresh
  tokens.
- **Heartbeat** — periodic `/heartbeat`; on `401` it refreshes the access
  token; if refresh fails it marks the device `revoked` and restarts pairing.
- **State** — everything (device UUID, tokens, status) is persisted to
  `/var/lib/stackpi/state.json` (via `engine/app/state.py`). The API and
  sync code read the access token from here; the engine is the sole owner of
  token rotation.

### Portal — `portal/` (Next.js 16 / React 19 / Tailwind, port 80)
Serves two audiences from one app:

- **Kiosk pages** (touchscreen + HDMI displays): `/` (home menu),
  `/initial-setup`, `/internet`, `/device-config`, `/status`, `/trucks`,
  `/clock`, and the display wrappers `/screens/{info1,info2,touch}`.
- **Admin** (`/config/*`): full settings, reader management, logs, cloud-sync
  and registration status — reached over the LAN from any browser.

The portal proxies `/local/*` to the API via a Next.js rewrite
(`portal/next.config.ts`), so the browser only ever talks to port 80 and the
API stays bound locally.

---

## 3. Data layer — RAM Postgres with USB snapshots

The database deliberately lives in **tmpfs** (`/var/lib/postgresql-mem`) for
write performance and to spare the SD card from RFID-scan write amplification.
Durability comes from periodic **snapshots to a USB drive**
(`/mnt/stackpi-data`, vfat).

- `stackpi-pg-bootstrap.service` runs on every boot: if the tmpfs is empty it
  `initdb`s the cluster, creates the `csg` role + `stackpi` database, restores
  the latest USB snapshot if present, then applies the SQL migrations.
- `stackpi-postgresql.service` then owns the long-running postmaster.
- `stackpi-pg-snapshot.timer` `pg_dump`s to the USB on a schedule (keeping the
  last N dumps).
- `fsync`/`synchronous_commit`/`full_page_writes` are **off** — the snapshot is
  the durability boundary, not WAL.

**Migrations** (`db/sql/001_*.sql … 016_*.sql`) are plain, idempotent SQL
(`CREATE TABLE IF NOT EXISTS`, additive `ALTER`s). They're applied both by the
boot bootstrap and by `deploy.sh`, so re-running is always safe.

Key tables:
- `local_rfid_readers` — configured readers + their last polled status.
- `local_rfid_raw_scans` → `local_rfid_matches` → `local_rfid_processed_scans` — the scan pipeline.
- `cloud_sync_moves_assets`, `cloud_sync_people`, `local_asset_tags` — data synced down from BaseCampV2.
- `local_system_events` — the System Events feed.
- `local_app_settings` — all operator-configurable settings (key/value).

---

## 4. The RFID pipeline

1. A Zebra reader's IoT Connector **POSTs reads to `/rfid-tags`**.
2. `ingest_tags` inserts each read into `local_rfid_raw_scans` and runs
   `process_scan` **inline in the same transaction** — matching the tag's
   `id_hex` against synced asset/person data to produce a row in
   `local_rfid_matches` (`match_type` = asset / person / unmatched).
3. **Bad-tag check:** if the tag is a known asset that is *not* part of the
   active move (present in `local_asset_tags` but no move match), the ingest
   collects it and, **after the transaction commits**, calls `alerts.fire()`:
   plays a configured sound, emits a `kind="alert"` System Event, and the
   kiosk screens flash. Per-tag debounce prevents repeats. This is fast enough
   to alert before someone walks ~10 ft away.
4. `stackpi-scan-upload.timer` pushes processed scans up to BaseCampV2 with an
   adaptive batch size.
5. The `/status` page subscribes to SSE match/event streams for live display.

---

## 5. Cloud sync & device status (BaseCampV2)

BaseCampV2 is a **separate cloud repo/service** (FastAPI, `api.serversherpa.com`).
The Pi authenticates as a *device* using the Bearer token in
`state.json` and may only call the **`/stackpi/*`** namespace (never the user
`/portal/*` routes).

- **Sync down** (`portal_sync.py`): pulls moves, assets, people, and asset-tags
  from `/stackpi/sync/*` and bulk-replaces the local `cloud_sync_*` /
  `local_asset_tags` tables (TRUNCATE + INSERT in one transaction).
- **Setup wizard** (`setup.py`): proxies move locations, scan types, and the
  reader site/scan-type binding through `/stackpi/*`.
- **Device status** is a 3-state model surfaced on `/status` and the home bar:
  **Registered / Offline / Un-Registered**. The engine marks **Offline** after
  3 consecutive heartbeat failures and recovers on the next success; any `200`
  from a cloud call counts as "connected".

---

## 6. Kiosk display model

The kiosk session is **sway** (Wayland compositor) launching **chromium**
windows, started by `stackpi-kiosk.service` on `tty1`
(config: `deploy/sway/sway-kiosk.conf`, launcher:
`deploy/scripts/stackpi-kiosk-launch.sh`).

- **DSI-1** (PITFT50 touchscreen) → `http://localhost/` — the home menu.
- **HDMI-A-1** → `http://localhost/screens/info1`.
- **HDMI-A-2** (optional) → `/screens/info2`, spawned only if that output is
  actually connected.

Each `/screens/{id}` wrapper polls `/local/screens/{id}` and shows the selected
view (Clock / Status / Truck / **Cycle**) in a full-screen iframe; **Cycle**
rotates Status↔Truck every `screen_cycle_seconds`. Operators pick per-output
screens from the touchscreen **Config → Screens** panel, which writes those
settings. Because the displays just swap an iframe `src`, chromium never has to
restart to change what's shown.

---

## 7. Tech stack & conventions

- **Backend:** FastAPI + Pydantic; Postgres accessed via `psql` subprocess
  (trust-auth, localhost). No ORM, no Alembic.
- **Engine:** plain Python daemon, file-based state.
- **Frontend:** Next.js 16 (App Router), React 19, Tailwind, `lucide-react`
  icons, GSAP for the `/status` change-border animations. All kiosk pages are
  `"use client"`.
- **Reader TLS:** the Zebra firmware uses a self-signed cert and is only
  reachable on the LAN, so reader HTTPS calls use `verify=False` deliberately.
- **Live updates:** Server-Sent Events (SSE) for scans, matches, and system
  events — no websockets.
- **No containers / no Nginx:** native `systemd` services; the portal's own
  rewrite is the only "proxy".

---

## 8. Repository layout

```
api/        FastAPI app (app/) + tests/        — device-local HTTP API
engine/     Python registration/heartbeat agent
portal/     Next.js portal (kiosk pages + admin)
db/sql/     idempotent SQL migrations (001…)
deploy/
  bootstrap.sh                 one-shot fresh-Pi provisioner
  install.sh                   system packages + Node 20 + pgweb
  deploy.sh                    build + services + migrations
  scripts/
    setup-pg-memcluster.sh     RAM Postgres + USB snapshot one-time setup
    setup-kiosk.sh             display groups + multi-user + enable kiosk
    stackpi-pg-bootstrap.sh    per-boot initdb/restore/migrate
    stackpi-pg-snapshot.sh     USB snapshot
    stackpi-kiosk-launch.sh    chromium launcher
    stackpi-settings-helper.sh privileged settings helper (sudoers-gated)
  services/                    systemd unit + timer files
  sway/                        kiosk compositor config
  plymouth/                    boot splash theme
  assets/                      logo + alert sounds
scripts/    dev + test-deploy helpers (local)
docs/       this documentation
```
