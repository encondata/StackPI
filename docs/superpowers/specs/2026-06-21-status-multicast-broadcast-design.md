# Status multicast broadcast (remote-display sub-project #1)

**Date:** 2026-06-21
**Status:** Approved, implementing on `dev`.
**Scope:** primary StackPI only. The remote `display/` device is sub-project #2.

## Goal

Broadcast a compact status snapshot from the primary Pi over UDP multicast so
remote status displays (and anything else on the LAN) can render `/status` +
`/trucks` without polling the primary. One sender, fan-out to any number of
displays at constant cost.

## Wire format — `status` snapshot (one JSON datagram)

Shaped so the reused `/status` + `/trucks` components can render straight from it.

```jsonc
{ "v":1, "type":"status", "ts":"<iso8601>",
  "metrics": { … all /local/metrics fields … },         // status + trucks cards
  "reader":  { "state":"offline|degraded|online|reading", "name":… },
  "registration": { "status":"registered|offline|unregistered|unknown" },
  "activity": [ … last ~20 resolved RFID matches … ],
  "events":   [ … last ~20 system events … ] }
```

`activity`/`events` are bounded (~20 each) to keep the datagram small. It may
still exceed one Ethernet frame and get IP-fragmented on the LAN — acceptable
(same subnet; a lost fragment self-heals on the next heartbeat).

## Transport / channel

Reuse the notifier's multicast plumbing, refactored to `_emit(payload, group,
port)`. Status uses a **separate** group/port from the stack-light notifier:
`notify_status_*` settings, default **239.10.10.11:5006** + an enable flag.

## Sender — `api/app/status_broadcast.py`

A background asyncio task started by the API (FastAPI lifespan):
- **build_snapshot()** assembles the dict by reusing existing data functions
  (`local.local_metrics`, `rfid.get_active_reader`, `rfid.matches_recent`,
  recent system events, registration from `/local/status`). Blocking psql work
  runs via `run_in_executor` so it never stalls the event loop.
- **5s heartbeat + on-change:** the loop waits on `min(5s, dirty_event)`. In-API
  paths that change status call `mark_dirty()` (debounced, ~500ms min spacing)
  for low-latency emits. Reader-status changes come from the *poll* process
  (separate), so they ride the 5s heartbeat.
- Honors the enable flag; emits via `_emit` to the status group/port.

`mark_dirty()` is wired into `rfid_ingest` (post-commit) and
`system_events.emit`.

## Config

`Status broadcast` settings (enable + group + port) added to
`/config → Settings → Notifications` (GET/PUT extended).

## Code home + docs

Create the **`display/`** folder with `status-protocol.md` — the shared wire
spec both the primary sender and the future display consume.

## Testing

`test_status_broadcast.py`: snapshot shape + bounded lists (data fns mocked);
dirty/heartbeat wake logic (mocked clock + emit); group/port-parametric `_emit`
(reusing the notifier transport test). Existing notifier tests still pass after
the `_emit` refactor.

## Out of scope (this sub-project)

The remote `display/` device (receiver + kiosk + config + bootstrap); the
`/trucks` map/truck feed (still sample data); delta/compression of the snapshot.
