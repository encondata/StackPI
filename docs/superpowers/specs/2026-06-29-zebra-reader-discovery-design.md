# Zebra RFID reader network discovery

**Date:** 2026-06-29
**Status:** Approved, pending implementation plan

## Problem

The "Find readers automatically" panel in the Add-Reader dialog
(`portal/src/app/config/rfid/readers/page.tsx`) calls `POST /local/rfid/scan`,
which port-scans the subnet for hosts with a single TCP port open and returns
raw IPs. It has two limitations:

1. It scans one port (default 443), so an HTTP-only reader (port 80) is missed.
2. It does not confirm a host is a Zebra reader — any host with that port open
   (a printer web UI, a NAS, another server) lands in the results.

We want discovery to surface **only confirmed Zebra RFID readers**, the way
Zebra's 123RFID tool does — so the operator picks from a list of actual readers,
not a list of arbitrary IPs.

## Goal

Replace the raw open-port scan with a discovery pass that finds hosts on the
subnet, confirms each is a Zebra reader via a credential-free ZIOTC signature
check, and returns a normalized list. Build it so an mDNS-based discovery
(123RFID's true mechanism) can be added later without changing the result shape
or the UI contract.

## Decisions (locked)

- **Confirmation is credential-free.** No password is required to discover. We
  confirm a host is an FX9600 by hitting a ZIOTC endpoint without auth and
  checking for the reader's signature response. The reader's real name is still
  resolved later, at add-time, by the existing probe (`/cloud/nameAndDescription`).
- **Scan both 80 and 443.** A reader on either scheme is found.
- **Start with the scan approach (B).** The mDNS approach (A) is explicitly out
  of scope for this spec; only the result schema leaves room for it.

## Design

### 1. Discovery pipeline (`api/app/rfid.py`)

A function `discover_readers()` that:

1. Resolves the Pi's primary subnet via the existing `_primary_local_cidr()`,
   keeping the existing `SCAN_MAX_HOSTS` (/22) safety cap and the "subnet too
   large" / "could not determine local subnet" error behavior.
2. Port-scans every host on **both 80 and 443** concurrently, reusing the
   existing `_probe(host, port, timeout)` and a `ThreadPoolExecutor`
   (`SCAN_MAX_WORKERS`). Produces a set of `(ip, port)` that are open.
3. For each host with an open port, runs a credential-free ZIOTC signature
   check (below). Open-but-unconfirmed hosts are dropped.
4. Dedupes by IP. If a reader confirms on both 80 and 443, keep one entry and
   prefer **https/443**.
5. Returns a list of normalized results (schema in §2).

### 2. Result schema

The endpoint returns, so mDNS can merge in later without a schema change:

```json
{
  "subnet": "10.10.48.0/22",
  "scanned_count": 1024,
  "took_seconds": 3.2,
  "readers": [
    { "ip": "10.10.48.119", "scheme": "https", "port": 443,
      "name": null, "source": "scan", "confirmed": true }
  ]
}
```

`name` is always `null` from scan (the real name resolves at add-time). When
mDNS (A) is added later, `discover_via_mdns()` returns the same shape with
`source: "mdns"` and `name` populated, merged by IP.

### 3. ZIOTC signature check (credential-free)

A function `_is_ziotc_reader(scheme: str, ip: str, timeout: float) -> bool`:

- Sends `GET {scheme}://{ip}/cloud/version` with **no Authorization header**,
  `verify=False`, short timeout (~1s), no redirects.
- Confirms the host is a Zebra reader if the response carries a ZIOTC
  signature. Primary marker (verified live, per the `ziotc-local-rest-auth`
  note): an HTTP **500** whose body contains **"Authorization header missing"**
  (case-insensitive) — the ZIOTC server's response to an unauthenticated
  `/cloud/*` call. To tolerate firmware variation, also accept a response whose
  body mentions `jwt` together with `authorization`/`token`.
- Any connection error, timeout, or non-matching response → returns `False`
  (not a reader).
- **No silent caps:** `discover_readers` logs a one-line count of hosts that
  had a port open but failed the signature check, so the marker can be tuned
  against live readers without code archaeology. The exact marker is confirmed
  against the FX9600 on the Pi during rollout (same posture as the
  nameAndDescription field).

### 4. API endpoint

`POST /local/rfid/scan` returns the §2 shape (replacing the current
`{responded: [{ip, port}]}`). The request body's `port` field is removed; the
ports scanned are fixed at 80 and 443. The only consumer is the Add-Reader
dialog, updated in §5.

### 5. UI (`portal/src/app/config/rfid/readers/page.tsx`)

- `startScan()` calls the endpoint with no `port`, and reads `readers` instead
  of `responded`.
- The results list renders each confirmed reader with its IP and a **scheme
  badge** (HTTP/HTTPS). Because only confirmed readers are returned, only Zebra
  readers ever appear.
- Clicking a result fills **address + scheme + port** on the add form (today it
  fills only the IP).
- Manual IP entry is unchanged. The helper text is updated to say the scan
  finds Zebra readers on HTTP or HTTPS automatically.

## Testing

`api/tests/test_reader_discovery.py`, `requests`/`_probe` mocked:

- `_is_ziotc_reader`: 500 with "Authorization header missing" → `True`;
  a 200/404/HTML page → `False`; a connection error / timeout → `False`.
- `discover_readers` orchestration (with `_probe` and `_is_ziotc_reader`
  monkeypatched): hosts open on a port get confirmed and returned with the
  right scheme; unconfirmed hosts are excluded; a reader open on both 80 and
  443 dedupes to one entry preferring https.
- Subnet-resolution failures still map to the existing 500/400 responses.

The live subnet scan and the exact signature marker are verified against the
real reader during rollout (not unit-tested — network-bound).

## Out of scope

- The mDNS discovery (A) itself — only the schema and the `source` field leave
  room for it.
- Any change to the Initial Setup wizard's add-reader step.
- Credentialed name enrichment in the scan results (names resolve at add-time).
