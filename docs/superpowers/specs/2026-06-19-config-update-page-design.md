# /config Software Update page — design

**Date:** 2026-06-19
**Status:** Approved, implemented
**Scope:** Frontend only (portal). Admin port of the touchscreen Update feature.

## Goal

Give the `/config` admin UI the same software-update capability as the
touchscreen `device-config` Update panel: check current vs. latest version, run
the update (deploy.sh in a transient unit, reboot on success), and stream its log.

## Approach

No backend changes — reuse the existing, already-tested endpoints
`GET /local/update/status` and `POST /local/update/start` (same ones the
touchscreen `UpdatePanel` uses).

- **New page** `portal/src/app/config/settings/update/page.tsx` — light admin
  theme (white cards, matching the other /config pages). Same behavior as the
  touchscreen panel: on load, check status → show current vs. latest git SHA,
  "behind" count, up-to-date / available; **Update Now** enabled only when
  behind; while running, poll `/status` every ~1.5s and stream the log tail,
  ending in "rebooting" (success) or an error banner (failed). Reuses the same
  lint-clean effect patterns (await-first initial check, interval polling).
- **Sidebar** — add a "Software Update" child under **Settings**, after
  "Status Screen" (`/config/settings/update`), matching the nav grouping.

## Testing

Portal has no JS test harness → ESLint + `tsc`. Behavior is identical to the
already-verified touchscreen path; the API is covered by `test_update.py`. Live
update flow verified on-device previously (transient unit + reboot).
