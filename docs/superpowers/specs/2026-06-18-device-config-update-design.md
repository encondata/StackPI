# Device-Config Software Update — Design

**Date:** 2026-06-18
**Status:** Approved, implemented

## Problem

The kiosk's **Config → Update** panel (`portal/src/components/deviceconfig/UpdatePanel.tsx`)
was a placeholder with a disabled button. Operators had no way to pull the
latest software onto a Pi from the touchscreen — the only path was SSHing in
and re-running `deploy/deploy.sh` (or the full bootstrap). We want the Update
button to run the same "git pull + install" the bootstrap performs.

## Goals

- One-tap update from the 800×480 kiosk: pull latest, rebuild, restart, reboot.
- Reuse `deploy/deploy.sh` verbatim — **no second copy** of the update logic that
  can drift from the canonical deploy.
- Survive the fact that the update **restarts the very API and portal** serving
  the request.
- Show the operator current vs. latest version and live progress.

## Non-Goals

- Re-running system-package install (`install.sh`) or DB cluster setup. Those are
  first-provision concerns; `deploy.sh` already excludes them.
- Rollback / version pinning. Updates fast-forward the tracked branch (`main`).
- Auth — same LAN-trust posture as the rest of `/local/*`.

## Approach

### The core challenge

`deploy.sh` restarts `stackpi-api` and `stackpi-portal` partway through. A normal
request handler that shells out would be killed mid-run (it lives in the API's
cgroup). So the work must detach into its **own** cgroup.

### Components

1. **`deploy/deploy.sh` made EUID-aware** (minimal refactor, no behavior change
   for interactive runs). When run as root it drops the git/pip/npm build steps
   to the repo owner via `runuser` (so `.git`/`.venv`/`node_modules` stay
   user-owned and npm/pip don't misbehave as root). The privileged steps keep
   using plain `sudo`, which works in both modes (root runs sudo without a
   prompt). A `BUILD_USER` derived from `stat` of the repo dir picks the owner.

2. **`deploy/scripts/stackpi-update.sh`** — root-owned, installed to
   `/usr/local/sbin`, invoked by the API via a scoped NOPASSWD sudoers entry
   (`deploy/sudoers.d/stackpi-update`), mirroring the existing settings-helper
   pattern (one auditable privileged surface; csg can't modify the script).
   - `start`: snapshots itself to `/run/stackpi/update-run.sh` (so `deploy.sh`
     reinstalling the on-disk copy mid-run can't corrupt the running script),
     then launches the work in a **transient systemd unit** via `systemd-run
     --unit=stackpi-update --collect`. Returns immediately. Guards against
     stacking via `systemctl is-active`.
   - `run` (inside the unit): runs `deploy.sh`, tees output to
     `/run/stackpi/update.log`, writes `running|success|failed` to
     `/run/stackpi/update.state`, and `shutdown -r now` on success (brief sleep
     first so a final UI poll observes `success`).

3. **`deploy.sh` install step** — installs the updater + sudoers drop-in
   (visudo-validated), alongside the existing settings-helper install.

4. **`api/app/update.py`** (new router, prefix `/local/update`):
   - `GET /status` — `git fetch` (best-effort/offline-safe) then report
     `current`/`latest` short SHAs, `behind` count, `update_available`,
     `fetch_ok`, plus the run `state` and `log_tail` from `/run/stackpi`.
     Repo dir is derived from the module path (`parents[2]`).
   - `POST /start` — idempotent while `state == running`; otherwise `sudo -n`
     the updater's `start`.

5. **`UpdatePanel.tsx`** — checks on open; shows "up to date" vs.
   `current → latest (N behind)`; **Update Now** enabled only when behind. On
   start it switches to a streaming view that polls `/status` every 1.5s and
   tails the log, ending in "rebooting…" (success) or an error banner (failed).

### Data flow

```
UpdatePanel ──POST /local/update/start──▶ update.py ──sudo -n──▶ stackpi-update.sh start
                                                                      │ systemd-run (own cgroup)
                                                                      ▼
                                                            stackpi-update.sh run
                                                                      │ deploy.sh (as root → builds as csg)
                                                                      │ writes /run/stackpi/update.{state,log}
                                                                      ▼
UpdatePanel ◀──GET /local/update/status (poll 1.5s)──── reads state+log     ──▶ reboot on success
```

## Security

- csg already has (password-gated) sudo — the device's trust boundary is the
  LAN. The new NOPASSWD entry is scoped to one root-owned script, consistent
  with `stackpi-settings-helper.sh`; it doesn't widen what csg can ultimately do.
- The updater takes no caller-supplied arguments, so there's no injection
  surface from the API into the privileged script.

## Testing

- `api/tests/test_update.py` — status shape & `update_available` logic, offline
  `fetch_ok`, git-error → 500, start trigger vs. idempotent-while-running vs.
  trigger-failure → 500, and state/log file reads.
- `bash -n` on both scripts; `visudo -c` on the sudoers drop-in.
- ESLint on the panel. Full runtime verification requires a Pi (systemd-run,
  reboot) and is performed on-device.
