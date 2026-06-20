# Reader endpointConfig — pull / edit / commit

**Date:** 2026-06-19
**Status:** Approved (design), implementing the pull/edit/commit slice
**Scope:** `/config/rfid/readers` admin page + API. Vertical slice on the Zebra
FX9600 IoT Connector **endpointConfig** (the cloud-connector that controls where
the reader ships tag reads).

## Goal

From the admin reader page, **pull** a reader's current endpoint config, **edit**
it, and **commit** it back to the reader. Eventually a one-click **"point this
reader at this Pi"** action that writes an HTTP data connection to this Pi's
`http://<pi-ip>:8000/rfid-tags` (which is exactly what was missing the first time
a reader silently failed to deliver tags).

## Zebra API facts (from the FX9600 ZIOTC Local REST API)

- **Read:** the endpoint config is nested in `GET /cloud/config` at
  `READER-GATEWAY.endpointConfig`. No dedicated GET — extract that subtree.
- **Write:** read-modify-write via `PUT /cloud/config` (GET config → splice
  `READER-GATEWAY.endpointConfig` → PUT the whole config back). The dedicated
  `PUT /cloud/cloudConfig` import endpoint does NOT exist on firmware 3.29.x
  (returns `404 "/cloudConfig is not a valid URI"` — verified on the live
  reader, `readerApplication 3.29.19.0`); `PUT /cloud/config` returns 200.
- **endpointConfig shape:**
  `data.event.connections[]` (tag-read data — the one that targets the Pi),
  `control.commandResponse.connections[]`,
  `management.{event,commandResponse}.connections[]`. Each connection has
  `type` (`mqtt` | `http` | …), `options` (`endpoint{hostName,port,protocol}`,
  `enableSecurity`, `security`, `basicAuthentication`, `additional`,
  `publishTopic`), `name`, `description`, `additionalOptions{batching,retention}`.
- Auth: two-step JWT — `GET /cloud/localRestLogin` (HTTP Basic) → bearer token on
  every other `/cloud/*` call.
- **Known unknown:** the sample bodies are `type:"mqtt"`. We will use **HTTP**.
  The exact HTTP-connection `options` shape (where the `/rfid-tags` path lives)
  is not yet captured, so the **point-at-Pi** button is deferred until we pull a
  real HTTP connection from a reader configured via its web console.

## Components

### Backend — `api/app/zebra_iot.py`
Port the reference `FX9600Client` (clean JWT client: lazy login, refresh ~30s
before `exp`, retry once on auth error; `ZiotcError` carries the reader's status
+ body). Build it from the DB reader row (`address`, `scheme`, `port`,
`admin_username`, `admin_password`) — same fields `rfid_status.py` reads. Added
**alongside** the existing ad-hoc client; we do not refactor the status/start-stop
paths now (contained risk; consolidation later).

New routes on the existing `/local/rfid` router:
- `GET  /readers/{id}/endpoint-config` — login → `get_config()` → return
  `READER-GATEWAY.endpointConfig` (404/empty handled).
- `PUT  /readers/{id}/endpoint-config` — body `{endpointConfig}` →
  `PUT /cloud/cloudConfig`.
- *(deferred)* `POST /readers/{id}/point-at-pi` — construct an HTTP
  `data.event` connection to `http://<pi-ip>:8000/rfid-tags` and PUT it.

### Frontend — "Endpoint Config" modal on `config/rfid/readers/page.tsx`
Hybrid editor (chosen over a full structured form: the config is deeply nested
and type-dependent, so a form is brittle; pure JSON is fine for this technical
admin page):
- **Pull current** → show `endpointConfig` as formatted, editable JSON
  (textarea) with client-side JSON validation.
- **Commit to reader** → PUT the edited JSON back, then re-pull to confirm.
- *(deferred)* **Point this reader at this Pi** button.
- Opened per-reader from the readers list, mirroring the existing
  `ReaderDetailsModal` / `EditReaderModal` pattern.

## Data flow

```
modal → GET /local/rfid/readers/{id}/endpoint-config
          → zebra_iot.FX9600Client(login → GET /cloud/config) → READER-GATEWAY.endpointConfig
      ← formatted JSON, user edits
      → PUT /local/rfid/readers/{id}/endpoint-config {endpointConfig}
          → FX9600Client.import_cloud_config (PUT /cloud/cloudConfig)
      → re-pull
```

## Error handling

Reader can be unreachable or its IoT Connector wedged (we have seen `/cloud/*`
hang). Every reader call uses a timeout; `ZiotcError` surfaces the reader's real
status + body to the modal; failures never block the page. Invalid JSON in the
editor is caught client-side before PUT.

## Testing

- `api/tests/test_zebra_iot.py` — client unit tests with `requests` mocked: login
  token parse + bearer header, retry-once-on-auth-error, `ZiotcError` on non-2xx,
  `get_config`/`update_config`/`import_cloud_config` paths.
- Endpoint tests with the client mocked: extract `READER-GATEWAY.endpointConfig`,
  PUT passthrough, reader-error → HTTP 502/surfaced.
- Live reader I/O verified on-device.

## Out of scope (this slice)

General `readerConfig` (xml / GPIO-LED) editing; consolidating the two reader
clients; the point-at-Pi button (fast-follow once the HTTP shape is captured).
