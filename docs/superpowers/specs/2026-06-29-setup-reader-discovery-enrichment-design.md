# Reader discovery: default-password name enrichment + Setup Step 2 surface

**Date:** 2026-06-29
**Status:** Approved, pending implementation plan

## Problem

The Zebra reader discovery scan (`POST /local/rfid/scan`) confirms readers
credential-free and returns them by IP — no name. And it is only reachable from
the Config → RFID → Readers dialog, not from the Initial Setup wizard's reader
step. We want discovery to (1) retrieve each reader's real name by trying a
short list of known default passwords, and (2) be usable directly in Initial
Setup Step 2, so the operator picks a named reader instead of typing an IP.

## Decisions (locked)

- **Built-in password list, in code:** `("Cumulu$SG0", "Cumulu$SG.", "changeme")`
  in that order; admin username `admin`.
- **Name retrieval happens during the scan**, for every confirmed reader.
- **`cred_index` (the index of the working default), not the literal password,
  crosses to the frontend.** The password lives only in code and the DB.
- The enrichment goes into the existing shared `/local/rfid/scan` so both the
  config page and the wizard benefit from one code path.

## Design

### 1. Default-password name enrichment (`api/app/rfid.py`)

```python
_DEFAULT_READER_PASSWORDS = ("Cumulu$SG0", "Cumulu$SG.", "changeme")
```

After `_is_ziotc_reader` confirms a host (and the scheme is chosen), enrich it:
try each password by index against `/cloud/localRestLogin` (reusing
`rfid_status._login`); on the **first success**, fetch
`/cloud/nameAndDescription` (`rfid_status._get_name_and_description`) and extract
the short name via the existing `_reader_name_from_nd`. Record the name and the
index. Stop at the first success. If no password works, `name=None` and
`cred_index=None` (the reader is still returned as confirmed).

Each scan result becomes:

```json
{ "ip": "10.10.48.119", "scheme": "https", "port": 443,
  "name": "FX9600647D23", "source": "scan", "confirmed": true,
  "cred_index": 0 }
```

`cred_index` is `null` when no default worked.

### 2. Adopt endpoint (`POST /local/rfid/readers/adopt`)

Request: `{address: str, scheme: str, cred_index: int}`. The backend resolves
`_DEFAULT_READER_PASSWORDS[cred_index]`, logs in **once** with that known-good
password (so no extra failed attempts beyond the scan), fetches the name, and
creates the reader row (reusing `create_reader` / `ReaderCreateRequest`) with
`scheme`, the resolved name, `admin_username="admin"`, and the password stored
in `admin_password` so the poller can authenticate later. Returns the updated
reader payload (same shape as `create_reader`). Errors: bad/missing
`cred_index` → 400; login/create failure → 502.

### 3. Initial Setup Step 2 UI (`portal/src/components/wizard/StepReader.tsx`)

Add a **"Scan for readers"** button alongside "Recheck". It calls
`POST /local/rfid/scan` and renders a list of discovered (unconfigured) readers,
each showing its **name** (or IP if unnamed) and a scheme badge. Picking one:

- `cred_index != null` → `POST /local/rfid/readers/adopt {address, scheme,
  cred_index}`; on success the new reader is created, the list refreshes, and it
  is auto-selected (the existing `select`/`pointAtPi` flow runs).
- `cred_index == null` → open the existing add sheet pre-filled with the IP and
  scheme, prompting for the password (existing manual flow).

The manual add sheet and the configured-readers list are unchanged. Discovered
readers already present in the configured list are not shown twice (filter by
address).

### 4. Reuse

`connect_autodetect`, `_login`, `_get_name_and_description`,
`_reader_name_from_nd`, `_is_ziotc_reader`, `discover_readers`, `create_reader`
are all reused. No new transport code.

## Safety

- Stop at the first successful password; short fixed list (3); tried
  sequentially per reader.
- `cred_index` (an index into a code-only list), never the literal password, is
  returned to the frontend.
- The password is persisted in the reader row exactly as the manual add flow
  already does.
- A reader with no matching default incurs up to 3 failed logins per scan; with
  the known-good passwords ordered first, real readers match on attempt 1.
  Repeated scans of a non-matching host accumulate attempts — acceptable given
  the fixed short list; revisit if a reader is found to lock the admin account.

## Testing

- Enrichment: first-success ordering returns the right `cred_index`; name comes
  from `nameAndDescription` via `_reader_name_from_nd`; no-match yields
  `name=None, cred_index=None`; the reader is still returned confirmed. `_login`
  and `_get_name_and_description` mocked.
- `discover_readers` still returns the §1 shape with the new keys.
- Adopt: valid `cred_index` resolves the password, logs in, and creates the
  reader (login/name/create mocked); out-of-range/None `cred_index` → 400;
  login failure → 502.
- Wizard verified via `tsc --noEmit` (no React component test runner).

## Out of scope

- Operator-editable password list (built-in only for now).
- mDNS discovery (the result schema still carries `source` for it later).
- Changes to the manual add flow beyond pre-filling IP+scheme on a no-credential pick.
