# Reader endpoint config in Edit/Details + "Use Pi IP" commit-on-save

**Date:** 2026-06-19
**Status:** Approved, implemented
**Scope:** `/config/rfid/readers` page + one new API route.

## Goals

1. Move the standalone "Endpoint" raw-JSON editor off the table row: the
   **Details** modal shows endpoint **key details** (parsed, read-only); the
   **Edit** modal carries the **raw JSON** pull/edit/commit editor.
2. Make the Edit modal's existing **"Use Pi IP"** button (which sets the Local
   URL) actually take effect: **on Save Changes**, push that Local URL to the
   reader's IoT-Connector endpoint.

## Reader fact (verified live, FX9600 3.29.x)

The tag-data connection is `endpointConfig.data.event.connections[]` with
`type: "httpPost"` and a single `options.URL` string (e.g.
`http://<pi>:8000/rfid-tags`) plus a no-auth `security` block. So repointing the
reader at a Pi is just rewriting that URL string — no host/port modelling.

## Backend

- `rfid_status.set_endpoint_url(reader_id, url)` — read-modify-write on
  `/cloud/config`: `_apply_endpoint_url(config, url)` sets the first `httpPost`
  connection's `options.URL`, creating the StackPI connection (from a template
  mirroring the live shape: `type httpPost`, `name StackPI`,
  `security.authenticationType NONE`) and any missing nesting if absent,
  preserving every other connection/setting. Uses the existing
  `_get_config`/`_put_config`.
- Route `POST /local/rfid/readers/{id}/endpoint-url {url}` (404/400/502 like the
  other reader routes). The raw editor keeps using `PUT …/endpoint-config`.

## Frontend (`config/rfid/readers/page.tsx`)

- **Remove** the table-row "Endpoint" button + `EndpointConfigModal`.
- **`EndpointConfigEditor`** (Edit modal section) — pulls on demand (button, not
  on Edit-open, to avoid reader I/O every time), edits raw JSON, commits via
  `PUT …/endpoint-config`.
- **`EndpointDetails`** (Details modal section) — auto-pulls and shows each
  `data.event` connection's name, type, address (`options.URL` or host:port),
  and auth type. Read-only.
- **`submitEditReader`** — after the DB row saves, if `local_method == "api"` and
  Local URL is set, `POST …/endpoint-url {url}`. The DB save always wins; a
  reader-push failure only downgrades the banner ("Saved … Reader endpoint NOT
  updated: <err>"), never blocks the save.

## Testing

- `test_endpoint_config.py` — `_apply_endpoint_url` (update existing, create from
  template, build nesting, preserve other connections), `set_endpoint_url`, and
  the route (200/422/502). 23 tests pass.
- ESLint + `tsc` on the page; reader I/O verified on-device.

## Out of scope

Pushing on Add-reader (only Edit for now); MQTT/local-disable → reader commit
(only `api`/httpPost); consolidating the two reader clients.
