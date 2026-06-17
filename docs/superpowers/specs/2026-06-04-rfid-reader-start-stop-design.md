# RFID Reader Start/Stop — Design

Date: 2026-06-04
Scope: Add a per-reader Start/Stop action button to the `/config/rfid/readers` page that controls live tag reading on the Zebra IoT Connector and reflects the reader's actual runtime state.

## Goals

- Show the operator whether each enabled reader is currently reading tags.
- Let the operator start or stop reading from the page with one click.
- Reflect the true reader state (not just our last-cached belief).

## Non-Goals

- No changes to the existing 30s background poller (`reader_poller.py`) or to the `last_status` / `last_error` columns. Those keep being owned by the poller.
- No DB schema changes.
- No new auth / permissions surface — same LAN-trust posture as the rest of `/local/*`.
- No support for non-Zebra reader types in this iteration (Impinj LLRP would be a separate design).

## Background

- `local_rfid_readers` rows already carry `enabled`, address, credentials, scheme/port, and a `last_status` JSONB that the 30s poller writes (`version`, `mode`, `config`).
- The page (`portal/src/app/config/rfid/readers/page.tsx`) already polls `GET /local/rfid/readers` every 10s and renders a row per reader with Details / Edit / Delete buttons.
- `ZebraIoTClient` (`api/app/zebra_iot.py`) already handles JWT login + bearer auth + 401 re-login retry for GET and PUT-JSON. It does not yet expose POST-without-body or runtime read.

## Control Surface Decision

Use the IoT Connector **runtime** endpoints (`POST /cloud/start`, `POST /cloud/stop`, `GET /cloud/runtime`) — not `PUT /cloud/mode`. Mode change is heavier and persists config; runtime control is the idempotent toggle we want for an operator-facing button.

> Caveat: the exact Zebra paths (`/cloud/start`, `/cloud/stop`, `/cloud/runtime`) and the precise shape of the `/cloud/runtime` response will be verified against the live FX9600 at 10.10.48.167 as the first implementation step. If Zebra uses different paths or response keys, the only change required is the three new methods on `ZebraIoTClient` — the route surface and frontend stay the same. This is a known unknown, called out so it surfaces immediately during implementation rather than during integration.

## Architecture

### New backend endpoints (`api/app/rfid.py`)

| Method | Path | Behavior |
|---|---|---|
| `GET`  | `/local/rfid/readers/runtime`    | Bulk live-fetch `/cloud/runtime` for every **enabled** reader in parallel. Returns `{ [id]: { running: bool \| null, raw: any \| null, error: string \| null } }`. On per-reader exception: `running: null, raw: null, error: "<short>"`. On success: `running` derived from the `/cloud/runtime` response, `raw` is the unmodified response body, `error: null`. Returns HTTP 200 even if every reader fails (DB enumeration errors still return 500). |
| `POST` | `/local/rfid/readers/{id}/start` | Look up reader (404 if missing). Call `client.start()`, then `client.get_runtime()`. Returns the post-action runtime state. 502 on reader failure with a short `detail`. |
| `POST` | `/local/rfid/readers/{id}/stop`  | Symmetric. |

Fan-out reuses the poller's existing pattern: `concurrent.futures.ThreadPoolExecutor(max_workers=POLL_MAX_CONCURRENCY)` with `POLL_TIMEOUT_PER_READER` (8s) per reader. The cap and timeout are copied into module-level constants in `rfid.py` rather than imported from `reader_poller.py` to keep these two subsystems decoupled (the poller can change cadence independently).

### `ZebraIoTClient` additions (`api/app/zebra_iot.py`)

- `get_runtime()` → `GET /cloud/runtime`, parsed JSON.
- `start()` → `POST /cloud/start` with bearer auth, no body. Raises for non-2xx.
- `stop()` → `POST /cloud/stop` with bearer auth, no body. Raises for non-2xx.
- `_post_action(path)` — internal helper that mirrors `_request_json` minus the body and content-type, including the 401 re-login retry.

### Frontend changes (`portal/src/app/config/rfid/readers/page.tsx`)

New per-reader state:

```ts
type RuntimeState = { running: boolean | null; error: string | null };
const [runtime, setRuntime] = useState<Record<number, RuntimeState>>({});
const [busyRuntime, setBusyRuntime] = useState<Record<number, boolean>>({});
```

The existing `tick()` is widened to fetch the list and the runtime map in parallel via `Promise.allSettled`, so one failing stream does not blank the other:

```ts
async function tick() {
  const [listRes, runtimeRes] = await Promise.allSettled([
    fetch("/local/rfid/readers", { cache: "no-store" }),
    fetch("/local/rfid/readers/runtime", { cache: "no-store" }),
  ]);
  // apply each result independently; keep last-good on failure
}
```

A new Action-column button is inserted between Details and Edit:

| Runtime state for reader `r` | Button |
|---|---|
| `runtime[r.id]?.running === true`  | Red **Stop**, enabled |
| `runtime[r.id]?.running === false` | Green **Start**, enabled |
| `runtime[r.id]?.running == null` (error or not yet fetched) | **Start**, disabled, `title={runtime[r.id]?.error ?? "Status unknown"}` |
| `!r.enabled` | No button — the row is a config stub |

While `busyRuntime[r.id]` is true: button disabled with an inline spinner. Pattern matches existing `busyAdd`/`busyEdit`/`busyDelete` flags.

Click handlers POST to the start/stop endpoint, merge the returned state into `runtime[id]`, and flash success/error in the existing top banner. No optimistic flip — the spinner stays until the server response lands.

## Data Flow

### Per-tick read (every 10s while the page is open)

```
browser tick()
  ├─ GET /local/rfid/readers           ── cheap psql read ──> DB row dump
  └─ GET /local/rfid/readers/runtime   ── fan-out ──> [enabled readers]
                                         ThreadPoolExecutor(max=5)
                                         per-reader: ZebraIoTClient.get_runtime()
                                         8s timeout each, exceptions caught
                                         returns {id: {running, raw, error}}
```

### Click path

```
button click
  └─ POST /local/rfid/readers/{id}/start  (or /stop)
       ├─ row lookup                      ── 404 if missing
       ├─ ZebraIoTClient.start()          ── 502 on reader failure
       └─ ZebraIoTClient.get_runtime()    ── authoritative post-action state
       returns { running, raw, error: null } | HTTPException
  └─ 2xx: merge into runtime[id] immediately (no waiting for next tick)
  └─ non-2xx: top banner shows body.detail; button re-enables for retry
```

## Error Handling

| Failure | Behavior |
|---|---|
| Per-reader `/cloud/runtime` fetch fails (during bulk) | Bulk response carries `{running: null, error: "<short>"}` for that id. Button renders disabled Start with the error in `title`. No banner — too noisy at 10s cadence. |
| Start/stop POST fails at the reader | API returns HTTP 502 with `detail = short error string`. Browser shows the existing banner; button re-enables for retry. |
| Reader row not found | 404 with `detail = "reader not found"`. Banner flashes. |
| Auth fail (401 from Zebra) | `ZebraIoTClient` transparently re-logins once. If still 401, surfaces as 502 with `detail = "HTTP 401: ..."`. |
| Two operators racing start/stop clicks | No locking. Last write wins at the reader; next runtime tick converges the UI. Acceptable for a 2-button LAN console. |

**No DB writes** for runtime state — it is transient and reader-authoritative. `last_status` / `last_error` remain owned exclusively by the 30s poller. This avoids two writers fighting over the same row.

## Testing

### Backend unit tests (`api/tests/test_rfid_runtime.py`)

- `test_runtime_bulk_returns_per_reader_state` — patch `ZebraIoTClient.get_runtime` for two fake enabled readers; assert each id appears with `running` populated and `error: null`.
- `test_runtime_bulk_isolates_failures` — reader A's `get_runtime` raises `requests.ConnectionError`, reader B returns OK. Assert A has `running: null, error: "ConnectionError: ..."`, B is intact, response is HTTP 200.
- `test_runtime_bulk_only_enabled_readers` — one enabled + one disabled; assert disabled reader is absent from the response map.
- `test_start_calls_cloud_start_then_returns_runtime` — patch `client.start()` and `client.get_runtime()`; assert route calls both in order and returns the post-action state.
- `test_start_propagates_reader_failure_as_502` — `client.start()` raises; assert HTTP 502 with a short `detail`.
- `test_start_returns_404_for_unknown_reader` — POST to a nonexistent id → 404.
- Stop coverage: one happy path + one failure (no need to mirror every start test).

### `ZebraIoTClient` unit tests

- `test_get_runtime_uses_bearer_and_parses_json` — mock `requests.request`; assert URL/headers and parsed return.
- `test_start_posts_with_bearer` — mock; assert POST method and `Authorization: Bearer ...` header.
- `test_action_retries_after_401` — first response 401, second 200; assert re-login happened exactly once and final return is the 200 body.

### Frontend

No new unit tests — the page has no Jest/RTL setup, and bootstrapping one is out of scope. Manual verification only:

- Load page with a running reader → red Stop visible.
- Click Stop → spinner, then green Start.
- Click Start → spinner, then red Stop.
- Break a reader's network (e.g., bogus port in DB) → Start button disabled with error tooltip; rest of the page still works.

## Out of Scope

- Background poller changes (still owns `last_status` / `last_error`).
- DB schema changes.
- Non-Zebra reader types.
- Page-level Jest/RTL test scaffolding.
- Live-reader integration tests in CI.
