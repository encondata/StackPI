# In-app updater — branch & commit selection

**Date:** 2026-06-20
**Status:** Approved, implemented (on `dev`).
**Scope:** `update.py`, the updater script, `deploy.sh`, the `/config` update page.

## Goal

Let the `/config → Software Update` page choose **any remote branch** and a
**specific commit** on it, then deploy that exact branch@commit (rebuild +
reboot). Enables testing `dev` and rolling back to an older commit. The
touchscreen panel is unchanged.

## Backend (`api/app/update.py`)

- `GET /branches` → `{current_branch, branches[], fetch_ok}` (all `origin/*`).
- `GET /commits?branch=X&limit=N` → `{branch, commits:[{sha,short,date,subject}]}`
  (newest first; the first is the tip).
- `GET /status?branch=X&commit=SHA` → `current` (+`current_branch`) vs `target`
  (branch tip, or the given commit), `update_available` = they differ, plus
  `state`/`log_tail`. **Params optional** — with none, target = the current
  branch's tip, keeping `latest_short`/`behind`/`update_available` so the
  **touchscreen panel works unchanged** (it now tracks the device's branch
  rather than hardcoded `main`).
- `POST /start {branch?, commit?}` → `_trigger_update(branch, commit)` →
  `sudo -n stackpi-update.sh start <branch> <commit>`.
- **Validation:** branch/commit must match `^[A-Za-z0-9._/-]{1,100}$` (they reach
  `git checkout`/`reset`); reject → 400 before launching anything.

## Updater chain

- `stackpi-update.sh start [branch] [commit]` re-validates the refs, passes them
  to the transient unit via `STACKPI_BRANCH`/`STACKPI_COMMIT`.
- `deploy.sh` git step, when `TARGET_BRANCH` is set:
  `git fetch --prune origin <branch>` → `git checkout -f -B <branch>
  origin/<branch>` → `git reset --hard <commit-or-tip>` (as the repo owner).
  Switches across diverged branches and lands an exact commit. `reset --hard`
  discards local tracked changes — fine for a deploy target (build artifacts are
  gitignored). No target → unchanged `git pull --ff-only`.

## `/config → Software Update` page

Branch dropdown (default = current branch) → loads a Commit dropdown
(`latest (tip)` + recent commits as `short — subject`). Shows
`current_branch@sha → target_branch@sha`, a Refresh and a **Deploy selected**
button, then the existing streaming-log/reboot view.

## Testing

`test_update.py` (19): branches/commits endpoints + parsing, status with
branch/commit params + explicit commit, start passing branch+commit through,
bad-branch → 400 (injection guard), plus the existing status/start/reconcile
tests adapted. `bash -n` on both scripts; deploy.sh branch logic reviewed.
On-device: deploy `dev` to a Pi and confirm the switch + rebuild.
