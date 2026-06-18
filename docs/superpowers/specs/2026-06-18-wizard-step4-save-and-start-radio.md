# Initial-Setup Step 4 — Save + optional RFID radio start

**Date:** 2026-06-18
**Status:** Approved, implemented
**Scope:** Frontend only (portal). No API changes.

## Problem

Step 4 ("Confirm") of the initial-setup wizard ended with a single **Done**
button. The settings were committed silently on step 3's "Next", and there was
no way to start the reader reading from the wizard — the operator had to finish
setup, then go to the home screen and start the radio separately.

## Goal

On step 4, replace **Done** with two explicit finish actions:

1. **Save Settings & Start RFID Radio** — save the reader settings, then send the
   reader a start command so it begins reading, then return home.
2. **Save without starting radio** — save the settings and return home (the old
   Done behavior), leaving the radio stopped.

## Decisions (from brainstorming)

- **Save moves onto the buttons.** Step 3's "Next" now just advances; both
  step-4 buttons perform the save. This makes the labels literally accurate.
- **Confirmation before leaving** on the start path: on a successful start, show
  "radio started — reading", then auto-return home after ~2.5s (plus a "Go to
  Home now" button).
- **Start failure keeps the operator on step 4.** Settings are already saved, so
  show the start error with **Retry Start** + **Finish anyway** (→ home). They're
  never trapped, and they know the radio didn't start.

## Design

All logic lives in `StepSummary.tsx` as a small state machine:

```
idle ──Save & Start──▶ working(commit) ──fail──▶ commit_error ──Retry──▶ (re-run)
                                        └─ok──▶ working(start) ──ok───▶ started ──▶ home (auto + button)
                                                              └─fail─▶ start_error ──Retry Start / Finish anyway
idle ──Save only────▶ working(commit) ──ok──▶ home
                                        └─fail─▶ commit_error ──Retry──▶ (re-run)
```

- **commit:** `POST /local/setup/reader-settings` with `{reader_name, site_id,
  scan_type_id}` from wizard state (idempotent — safe to retry).
- **start:** `GET /local/rfid/active-reader` → `reader_id` → `POST
  /local/rfid/readers/{reader_id}/start` (existing login → `PUT /cloud/start` →
  status-refresh route).
- A mounted ref guards against `setState` after unmount, since the start call can
  take seconds against a slow/wedged reader.

`InitialSetupWizard.tsx` changes:
- Step 3 "Next" advances without committing (the `runCommit`/`committed`/`busy`
  plumbing moves into `StepSummary`).
- Step 4 renders `<StepSummary state onHome={() => router.push("/")} />`.
- The footer on step 4 shows only **Previous** (no right-side action); the two
  finish buttons live full-width in the step body (the labels are long for an
  800×480 footer).

## Components / boundaries

- `StepSummary` — owns confirm + commit + start. Inputs: `state`, `onHome`.
  Self-contained; the wizard no longer needs to know about commit results.
- `InitialSetupWizard` — pure step navigation + shared state.

## Error handling

- Commit failure → inline error + Retry (re-runs whichever button was pressed).
- Start failure (reader unreachable / IoT Connector wedged) → "settings saved,
  but radio didn't start — <detail>" with Retry Start + Finish anyway.
- Missing reader/site/scan in state → guarded before the commit fetch.

## Testing / verification

The portal has no JS test harness, so verification is ESLint + `tsc --noEmit`
type check + on-device click-through. The change is fetch orchestration over
existing, already-tested endpoints.
