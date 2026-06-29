# Reader scheme auto-detection (HTTPS → HTTP fallback) on add-reader

**Date:** 2026-06-29
**Status:** Approved, pending implementation plan

## Problem

The Initial Setup wizard's "Add reader" step hardcodes `scheme: "https"` when
probing and persisting a reader (`StepReader.tsx`, and `probe_reader` defaults
`scheme="https"`). There is no http/https selector, and we do not want to add
one. Different FX9600 firmware serve their ZIOTC Local REST API differently:

- Firmware 3.29.x serves the Local REST API over **plain HTTP on port 80**;
  a TLS handshake on 443 fails with `WRONG_VERSION_NUMBER`.
- Other configurations serve it over **HTTPS on 443**.

Hardcoding one scheme means the wizard fails on whichever readers use the other.
We want the wizard to figure out the right scheme itself.

## Goal

On add-reader, try HTTPS first; if HTTPS cannot establish a connection, fall
back to HTTP. The exception is a bad-password (authentication) error: if the
reader is reachable but rejects the credentials, surface that and do not fall
back. Persist whichever scheme actually connected.

## Decisions (locked)

- **Fallback trigger:** only connection-level failures (no HTTP response at all
  — connection refused, TLS handshake failure, timeout). If HTTPS returns any
  HTTP status, the reader is reachable over HTTPS, so we stop and surface that
  result rather than falling back.
- **Auth detection:** HTTP **401/403** from `/cloud/localRestLogin` counts as a
  bad-password error. (Exact FX9600 bad-password response to be confirmed live
  on the Pi; tighten if it differs.)
- **Scope:** the Initial Setup wizard's add-reader flow and its probe endpoint
  only. The runtime poller continues to use the stored scheme — no per-poll
  auto-detection. The standalone `ziotc_client.py` tool and the edit-reader
  card are out of scope; no scheme selector is added anywhere.

## Design

### 1. Typed login errors (`api/app/rfid_status.py`)

`_login` today raises plain `RuntimeError` with message prefixes. Introduce two
subclasses (both extend `RuntimeError`, so existing `except Exception` callers
in the poller are unaffected):

```python
class ReaderTransportError(RuntimeError):
    """No HTTP response — connection refused, TLS handshake failure, timeout."""

class ReaderAuthError(RuntimeError):
    """Reader reachable but rejected the credentials (HTTP 401/403)."""
```

`_login` maps failures as follows:

| Condition | Raises |
|---|---|
| `requests.RequestException` | `ReaderTransportError` |
| HTTP 401 or 403 | `ReaderAuthError` |
| other non-200 HTTP status | `RuntimeError` (generic) |
| 200 but body is not a JWT | `RuntimeError` (generic) |

Rationale: a generic `RuntimeError` means we got an HTTP response (reader
reachable on that scheme), so it must not trigger a scheme fallback.

### 2. `connect_autodetect(reader)` (`api/app/rfid_status.py`)

```python
def connect_autodetect(reader, schemes=("https", "http")):
    """Try each scheme in order. Return (scheme, token) on the first success.

    - ReaderTransportError -> record and try the next scheme.
    - ReaderAuthError or generic RuntimeError -> re-raise (reachable; surfacing
      the real error beats masking it with a fallback).
    - all schemes exhausted via transport errors -> RuntimeError.
    """
    last_err = None
    for scheme in schemes:
        try:
            token = _login({**reader, "scheme": scheme})
            return scheme, token
        except ReaderTransportError as e:
            last_err = e
            continue
    raise RuntimeError(
        f"could not reach reader over {'/'.join(schemes)}: {last_err}"
    )
```

`ReaderAuthError` and generic `RuntimeError` propagate out of the loop naturally
(not caught), so they stop the search immediately. The probe passes no port, so
`_base_url` derives 443 for the https attempt and 80 for the http attempt.

### 3. `probe_reader` endpoint (`api/app/rfid.py`)

- Default `ReaderProbeRequest.scheme` becomes irrelevant for the wizard path;
  the endpoint calls `connect_autodetect(reader)` to obtain `(scheme, token)`,
  then `_get_status(reader_with_scheme, token)`.
- Returns `{"ok": True, "scheme": scheme, "hostname": ..., "status": ...}`.
- Error mapping:
  - `ReaderAuthError` → HTTP **401**, detail `"authentication failed — check admin password"`.
  - any other failure → HTTP **502**, detail `"could not reach reader: <err>"`.

### 4. Wizard `connect()` (`portal/src/components/wizard/StepReader.tsx`)

- Read `scheme` from the probe response.
- Send `scheme: pb.scheme` (not hardcoded `"https"`) in `POST /local/rfid/readers`.
- On a 401 from the probe, show the auth/bad-password detail distinctly from the
  generic "could not reach reader" message.

### 5. Persistence / runtime

The detected scheme is stored on the `local_rfid_readers` row at create time.
The poller reads that stored scheme through `_base_url` as it does today. No
runtime auto-detection.

## Testing

New `api/tests/test_autodetect.py`, `requests` mocked via monkeypatch:

- `_login` typed exceptions: connection error → `ReaderTransportError`;
  HTTP 401 → `ReaderAuthError`; HTTP 500 → generic `RuntimeError`.
- `connect_autodetect`:
  - https login succeeds → `("https", token)`, http never attempted.
  - https transport error, http succeeds → `("http", token)`.
  - https auth error → raises `ReaderAuthError`, http never attempted.
  - https generic HTTP error → raises `RuntimeError`, http never attempted.
  - both schemes transport error → raises `RuntimeError`.

(Endpoint- and wizard-level tests depend on the FastAPI test client, which needs
`python-multipart` installed in the environment; the unit tests above cover the
logic without that dependency.)

## Verification on the Pi

After deploy, confirm against the live FX9600 (10.10.48.119) that:

1. Add-reader succeeds and persists the scheme the reader actually serves.
2. A deliberately wrong password yields the 401 "authentication failed" path,
   not a fallback to HTTP.

Confirm the reader's actual bad-password HTTP status; if it is not 401/403,
adjust the auth-detection check accordingly.
