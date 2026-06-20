# Initial setup — verify reader endpoint points at this Pi

**Date:** 2026-06-19
**Status:** Approved, implemented
**Scope:** Touchscreen initial-setup wizard, Step 2 (RFID Reader). Frontend only.

## Goal

When the operator selects a reader in initial setup, automatically **check** the
reader's endpoint, **set** it to this Pi's `/rfid-tags` URL if it differs, and
**verify** — and don't let setup advance until that's confirmed.

## Behavior (decided)

- **Fully automatic on select:** tapping a reader runs check → set → verify in one
  go, with a status line.
- **Required before Next:** Step 2's Next is disabled until the selected reader's
  endpoint is verified pointing at this Pi (a wedged/offline reader blocks
  advancing, with the error shown + Retry).

## Flow (`StepReader.tsx`)

1. **Pi URL:** `GET /local/settings` → first non-loopback `ip4` →
   `http://<ip>:8000/rfid-tags` (same source as the admin "Use Pi IP").
2. **Check:** `GET /local/rfid/readers/{id}/endpoint-config` → the `data.event`
   `httpPost` connection's `options.URL`. If it already equals the Pi URL →
   verified (no write).
3. **Set:** `POST /local/rfid/readers/{id}/endpoint-url {url}`.
4. **Verify:** re-`GET` and confirm the URL now equals the Pi URL exactly.
5. **Status line:** Checking… / Pointing reader at this Pi… / Verifying… /
   "✓ points at this Pi — <url>" / "✗ <error>" + Retry. A mounted ref guards
   against the reader I/O resolving after unmount.

Selecting a reader sets `readerName` and resets `endpointVerified=false`; a
successful verify sets it true. Adding a reader auto-selects it (and runs the
same flow). Re-tap / Retry re-runs the whole check-set-verify.

## Gating (`InitialSetupWizard.tsx`)

`WizardState` gains `endpointVerified: boolean`. Step-2 `canNext` becomes
`readerName != null && endpointVerified`.

## Backend

None — reuses `GET …/endpoint-config` and `POST …/endpoint-url` (read-modify-write
of the `httpPost` connection's `options.URL`, both already tested).

## Testing

Portal has no JS test harness → ESLint + `tsc`. The endpoint routes are covered
by `test_endpoint_config.py`; reader I/O verified on-device.
