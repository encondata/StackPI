# Set reader site + scan type from /config (not just Initial Setup)

**Date:** 2026-06-29
**Status:** Approved, pending implementation plan

## Problem

The reader's **site** (a move's source or destination) and **scan type** can only
be set by running the full 4-step Initial Setup wizard (Step 3 selects them,
Step 4 commits via `POST /local/setup/reader-settings`). An operator who only
wants to change which side of a move the reader scans, or its scan type, must
run the whole wizard. We want to change and verify this from a page in `/config`.

## Findings (shape the design)

- The **active move/event** is already settable outside the wizard, on the main
  `/config` page, via `POST /local/active-selection` (durable JSON file
  `/var/lib/stackpi/active_selection.json`).
- Site/scan type are **not stored locally** today — `set_reader_settings` only
  PATCHes BaseCamp and persists `active_reader_name` in `local_app_settings`.
- **There is no cloud API to read the reader's current site/scan type back.**
  BaseCamp exposes only the PATCH plus GETs for move-locations and scan-types;
  the local `cloud_sync_*` tables (moves, events, people, assets) don't carry
  reader settings. So showing the current value requires local persistence.

## Decisions (locked)

- The control lives as a **"Site & Scan Type" section on Config → RFID →
  Settings** (`portal/src/app/config/rfid/settings/page.tsx`).
- Current site/scan are **persisted locally in a durable file**
  `/var/lib/stackpi/reader_settings.json` (mirroring `active_selection.json`),
  so they survive a power-cut — the operator's stated concern.
- Saving reuses the **existing** `POST /local/setup/reader-settings` (cloud
  PATCH + local persist), so every downstream workflow/API path is unchanged.

## Design

### 1. Backend — persist + expose reader settings (`api/app/setup.py`)

Durable snapshot file, written with the same atomic-write pattern as
`active_selection.json` (tmpfile → fsync → `os.replace`, mode 0640):

```
/var/lib/stackpi/reader_settings.json
  {"reader_name": <str|null>, "site_id": <int|null>, "site_name": <str|null>,
   "scan_type_id": <int|null>, "scan_type_name": <str|null>}
```

- `ReaderSettingsRequest` gains optional `site_name: str | None` and
  `scan_type_name: str | None` (so display names persist; the cloud PATCH body
  is unchanged — still `reader_name`, `site_id`, `scan_type_id`).
- `set_reader_settings` (`POST /local/setup/reader-settings`): after the cloud
  PATCH succeeds, write the snapshot file with all five fields, in addition to
  the existing `active_reader_name` persist. (A snapshot-write failure logs a
  warning and does not fail the request — same best-effort posture as today.)
- New `GET /local/setup/reader-settings`: return the snapshot file's contents,
  or all-nulls if the file is missing/unparseable.

`active_reader_name` in `local_app_settings` is left as-is (the home card and
status broadcaster read it).

### 2. Frontend — "Site & Scan Type" section (`config/rfid/settings/page.tsx`)

A new card below the existing RFID settings, which on load fetches in parallel:
- `GET /local/setup/reader-settings` — current persisted values (pre-fill).
- `GET /local/active-selection` — the active move/event.
- `GET /local/setup/move-locations?move_id=<id>` — source/destination sites
  (only when the active selection is a `move`).
- `GET /local/setup/scan-types` — scan-type options.

UI: a **source/destination** dropdown (the two sites for the active move) and a
**scan type** dropdown (natural-sorted like Step 3), pre-selected from the
persisted values. A **Save** button → `POST /local/setup/reader-settings` with
`{reader_name, site_id, site_name, scan_type_id, scan_type_name}`. The
`reader_name` is the active reader's name (from the persisted snapshot, falling
back to `GET /local/rfid/active-reader`). Success/error shown in a banner,
matching the page's existing pattern.

### 2a. Wizard commit also sends names

`StepSummary`'s commit (`POST /local/setup/reader-settings`) is updated to also
send `site_name` and `scan_type_name` (already in the wizard's `state`), so a
reader configured through the wizard persists its display names and shows them
correctly on the new config section. No other wizard change.

### 3. Guard rails

- **No active reader** (no `reader_name`) → the section is disabled with
  "Add and select a reader first."
- **Active selection is not a move** (an event, or nothing) → the site dropdown
  is disabled with "Select a move on the Config home page first." Scan type can
  still be chosen and saved.
- A persisted `site_id` that is not the current move's source/destination (e.g.
  the move was changed) → the dropdown shows no pre-selection; the operator
  re-picks. No stale site is silently kept.

## Testing

- Backend: `set_reader_settings` writes the snapshot with all five fields (psql
  and BaseCamp mocked, snapshot path monkeypatched to a tmp dir); `GET
  /local/setup/reader-settings` returns the snapshot, and all-nulls when the
  file is absent. Tests call the endpoint functions directly (no TestClient, to
  avoid the python-multipart gap).
- Frontend: `tsc --noEmit`.

## Out of scope

- Reading the current setting from the cloud (no API exists).
- Changing the active move itself (already done on the main `/config` page).
- Any change to the wizard's Step 3/4 beyond §2a (sending the display names).
