# Reader Discovery Name Enrichment + Setup Step 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discovery tries a built-in list of default passwords to read each reader's name during the scan, and the Initial Setup wizard's Step 2 lets the operator pick a discovered (named) reader to add it.

**Architecture:** Backend adds `_DEFAULT_READER_PASSWORDS` + `_enrich_reader_name` (reusing the existing login/name helpers) into the scan's confirm pass, extending each result with `name` and `cred_index`. A new `POST /readers/adopt` creates a discovered reader server-side from a credential index (password never crosses to the client). The wizard `StepReader` gains a Scan button, a discovered-readers list, and adopt-on-pick.

**Tech Stack:** Python 3.13 / FastAPI / `requests` / pytest (API); Next 16 / React 19 / TypeScript (portal).

## Global Constraints

- Built-in password list (exact, in order): `_DEFAULT_READER_PASSWORDS = ("Cumulu$SG0", "Cumulu$SG.", "changeme")`; admin username is `admin`.
- Name retrieval runs during the scan, for every confirmed reader; try passwords in order, STOP at the first successful login.
- `cred_index` (the index of the working default, or `null`), NOT the literal password, is what the API returns to / accepts from the client.
- Reuse `rfid_status._login`, `rfid_status._get_name_and_description`, `_reader_name_from_nd`, `_is_ziotc_reader`, `discover_readers`, `create_reader`. No new transport code, no new dependencies.
- Scan result item shape (verbatim): `{ip, scheme, port, name, source: "scan", confirmed: true, cred_index}`.
- Reader HTTP uses `verify=False` (existing LAN posture). API tests import `app.rfid` directly (no FastAPI TestClient — avoids the python-multipart gap).
- Portal: straight ASCII quotes only (no curly quotes — they break compilation). Run `tsc` ONCE (no concurrent runs; first run 1-2 min).
- Spec: `docs/superpowers/specs/2026-06-29-setup-reader-discovery-enrichment-design.md`.

---

### Task 1: Default-password name enrichment

**Files:**
- Modify: `api/app/rfid.py` (add the constant + `_enrich_reader_name` near `_is_ziotc_reader` ~line 326-364; wire into `_confirm` ~lines 405-416)
- Test: `api/tests/test_reader_discovery.py` (append)

**Interfaces:**
- Consumes: `rfid_status._login`, `rfid_status._get_name_and_description`, `_reader_name_from_nd` (existing).
- Produces: `_DEFAULT_READER_PASSWORDS: tuple`; `_enrich_reader_name(scheme: str, ip: str) -> tuple[Optional[str], Optional[int]]` returning `(name_or_None, cred_index_or_None)`; `discover_readers` reader dicts now include `name` and `cred_index`.

- [ ] **Step 1: Write the failing tests (append to api/tests/test_reader_discovery.py)**

```python
from app import rfid_status


def test_enrich_first_success_returns_index_and_name(monkeypatch):
    from app.rfid import _enrich_reader_name
    tried = []

    def fake_login(reader):
        tried.append(reader["admin_password"])
        if reader["admin_password"] == "Cumulu$SG.":
            return "tok"
        raise RuntimeError("bad password")

    monkeypatch.setattr(rfid_status, "_login", fake_login)
    monkeypatch.setattr(rfid_status, "_get_name_and_description",
                        lambda reader, token: {"name": "FX9600647D23 FX9600 RFID Reader",
                                               "description": "FX9600 RFID Reader"})
    name, idx = _enrich_reader_name("https", "10.0.0.5")
    assert (name, idx) == ("FX9600647D23", 1)
    assert tried == ["Cumulu$SG0", "Cumulu$SG."]  # stopped at first success


def test_enrich_no_password_works(monkeypatch):
    from app.rfid import _enrich_reader_name

    def fail(reader):
        raise RuntimeError("bad password")

    monkeypatch.setattr(rfid_status, "_login", fail)
    assert _enrich_reader_name("https", "10.0.0.5") == (None, None)


def test_enrich_login_ok_but_name_fetch_fails(monkeypatch):
    from app.rfid import _enrich_reader_name
    monkeypatch.setattr(rfid_status, "_login", lambda reader: "tok")

    def boom(reader, token):
        raise RuntimeError("nd 500")

    monkeypatch.setattr(rfid_status, "_get_name_and_description", boom)
    name, idx = _enrich_reader_name("https", "10.0.0.5")
    assert name is None and idx == 0


def test_discover_includes_name_and_cred_index(monkeypatch):
    from app.rfid import discover_readers
    monkeypatch.setattr(rfid_mod, "_primary_local_cidr", lambda: "10.0.0.0/30")
    monkeypatch.setattr(rfid_mod, "_probe",
                        lambda h, p, t: h if (h == "10.0.0.1" and p == 443) else None)
    monkeypatch.setattr(rfid_mod, "_is_ziotc_reader",
                        lambda scheme, ip, timeout=1.0: scheme == "https")
    monkeypatch.setattr(rfid_mod, "_enrich_reader_name", lambda scheme, ip: ("FX9600X", 0))
    out = discover_readers()
    assert out["readers"] == [
        {"ip": "10.0.0.1", "scheme": "https", "port": 443, "name": "FX9600X",
         "source": "scan", "confirmed": True, "cred_index": 0}
    ]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_discovery.py -q`
Expected: FAIL — `ImportError: cannot import name '_enrich_reader_name'`.

- [ ] **Step 3: Add the constant and `_enrich_reader_name`**

In `api/app/rfid.py`, near `_is_ziotc_reader` / `_scheme_for_port`:

```python
# Built-in admin passwords tried, in order, to read a discovered reader's name.
# The cloud keys readers by name; the operator's fleet uses these defaults.
_DEFAULT_READER_PASSWORDS = ("Cumulu$SG0", "Cumulu$SG.", "changeme")


def _enrich_reader_name(scheme: str, ip: str):
    """Try the default admin passwords against a confirmed reader to read its
    name. Returns (name, cred_index): the short name (or None) and the index of
    the first password that logged in (or None if none did). Stops at the first
    successful login."""
    from app import rfid_status  # noqa: PLC0415
    for idx, password in enumerate(_DEFAULT_READER_PASSWORDS):
        reader = {
            "address": ip,
            "scheme": scheme,
            "port": None,
            "admin_username": "admin",
            "admin_password": password,
        }
        try:
            token = rfid_status._login(reader)
        except Exception:
            continue
        try:
            nd = rfid_status._get_name_and_description(reader, token)
            name = _reader_name_from_nd(nd)
        except Exception:
            name = None
        return (name, idx)
    return (None, None)
```

- [ ] **Step 4: Wire enrichment into `_confirm`**

Replace the `_confirm` inner function in `discover_readers`:

```python
    def _confirm(ip: str, ports: set) -> Optional[Dict[str, Any]]:
        for port in (443, 80):
            if port in ports and _is_ziotc_reader(_scheme_for_port(port), ip):
                scheme = _scheme_for_port(port)
                name, cred_index = _enrich_reader_name(scheme, ip)
                return {
                    "ip": ip,
                    "scheme": scheme,
                    "port": port,
                    "name": name,
                    "source": "scan",
                    "confirmed": True,
                    "cred_index": cred_index,
                }
        return None
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_discovery.py -q`
Expected: PASS (all tests, including the 7 pre-existing).

- [ ] **Step 6: Commit**

```bash
git add api/app/rfid.py api/tests/test_reader_discovery.py
git commit -m "feat(rfid): scan reads reader name via default passwords (cred_index)"
```

---

### Task 2: Adopt endpoint

**Files:**
- Modify: `api/app/rfid.py` (add `AdoptReaderRequest` near the other request models ~line 45-78; add `adopt_reader` endpoint near `create_reader` ~line 189)
- Test: `api/tests/test_reader_discovery.py` (append)

**Interfaces:**
- Consumes: `_DEFAULT_READER_PASSWORDS`, `_reader_name_from_nd`, `create_reader`, `ReaderCreateRequest` (existing), `rfid_status._login`, `rfid_status._get_name_and_description`.
- Produces: `AdoptReaderRequest(address: str, scheme: str, cred_index: int)`; `POST /local/rfid/readers/adopt` → returns the `create_reader` payload; 400 on out-of-range `cred_index`, 502 on login failure.

- [ ] **Step 1: Write the failing tests (append)**

```python
def test_adopt_creates_reader_from_cred_index(monkeypatch):
    from app.rfid import adopt_reader, AdoptReaderRequest
    monkeypatch.setattr(rfid_status, "_login", lambda reader: "tok")
    monkeypatch.setattr(rfid_status, "_get_name_and_description",
                        lambda reader, token: {"name": "FX9600647D23",
                                               "description": "FX9600 RFID Reader"})
    captured = {}

    def fake_create(body):
        captured["body"] = body
        return {"readers": [{"name": body.name}], "counts": {}}

    monkeypatch.setattr(rfid_mod, "create_reader", fake_create)
    out = adopt_reader(AdoptReaderRequest(address="10.10.48.119", scheme="https", cred_index=0))
    assert captured["body"].name == "FX9600647D23"
    assert captured["body"].admin_password == "Cumulu$SG0"
    assert captured["body"].scheme == "https"
    assert out["readers"][0]["name"] == "FX9600647D23"


def test_adopt_out_of_range_cred_index_400(monkeypatch):
    import pytest
    from fastapi import HTTPException
    from app.rfid import adopt_reader, AdoptReaderRequest
    with pytest.raises(HTTPException) as ei:
        adopt_reader(AdoptReaderRequest(address="10.0.0.5", scheme="https", cred_index=99))
    assert ei.value.status_code == 400


def test_adopt_login_failure_502(monkeypatch):
    import pytest
    from fastapi import HTTPException
    from app.rfid import adopt_reader, AdoptReaderRequest

    def boom(reader):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(rfid_status, "_login", boom)
    with pytest.raises(HTTPException) as ei:
        adopt_reader(AdoptReaderRequest(address="10.0.0.5", scheme="https", cred_index=0))
    assert ei.value.status_code == 502
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_discovery.py -q`
Expected: FAIL — `ImportError: cannot import name 'adopt_reader'`.

- [ ] **Step 3: Add `AdoptReaderRequest`**

Near the other request models in `api/app/rfid.py`:

```python
class AdoptReaderRequest(BaseModel):
    address: str = Field(min_length=1, max_length=255)
    scheme: str = Field(default="https", pattern=r"^https?$")
    cred_index: int = Field(ge=0)
```

- [ ] **Step 4: Add the `adopt_reader` endpoint**

Near `create_reader` in `api/app/rfid.py`:

```python
@router.post("/readers/adopt")
def adopt_reader(body: AdoptReaderRequest) -> Dict[str, Any]:
    """Create a reader the scan discovered, using a built-in default password
    selected by index (so the password never crosses from the client). Logs in
    once with that known-good password, reads the name, and persists the reader
    via the normal create path."""
    if body.cred_index >= len(_DEFAULT_READER_PASSWORDS):
        raise HTTPException(status_code=400, detail="no default credential for this reader")
    from app import rfid_status  # noqa: PLC0415

    password = _DEFAULT_READER_PASSWORDS[body.cred_index]
    scheme = (body.scheme or "https").strip().lower()
    address = body.address.strip()
    reader = {
        "address": address,
        "scheme": scheme,
        "port": None,
        "admin_username": "admin",
        "admin_password": password,
    }
    try:
        token = rfid_status._login(reader)
        nd = rfid_status._get_name_and_description(reader, token)
        name = _reader_name_from_nd(nd) or address
    except Exception as e:  # noqa: BLE001
        log.warning("reader adopt failed for %s: %s", address, e)
        raise HTTPException(status_code=502, detail=f"could not adopt reader: {e}")

    return create_reader(ReaderCreateRequest(
        name=name,
        address=address,
        scheme=scheme,
        admin_username="admin",
        admin_password=password,
    ))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_discovery.py -q`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add api/app/rfid.py api/tests/test_reader_discovery.py
git commit -m "feat(rfid): adopt endpoint creates discovered reader by cred_index"
```

---

### Task 3: Setup Step 2 — scan, discovered list, adopt-on-pick

**Files:**
- Modify: `portal/src/components/wizard/StepReader.tsx` (add discovered-reader type/state/scan/adopt in `StepReader` ~lines 38-185; header buttons ~lines 190-203; render discovered list before the "Add reader" button ~line 246; `AddReaderPanel` gains an `initialIp` prop ~lines 322-330; the `{adding && ...}` block ~lines 306-317)

**Interfaces:**
- Consumes: `POST /local/rfid/scan` → `{readers: [{ip, scheme, port, name, source, confirmed, cred_index}]}` (Task 1); `POST /local/rfid/readers/adopt {address, scheme, cred_index}` (Task 2). The `Reader` type already has `address`, `name`.

- [ ] **Step 1: Add the discovered-reader type**

Just below the existing `type Reader = {...}` block in `StepReader.tsx`:

```tsx
type DiscoveredReader = {
  ip: string;
  scheme: string;
  port: number;
  name: string | null;
  source: string;
  confirmed: boolean;
  cred_index: number | null;
};
```

- [ ] **Step 2: Add scan/adopt state and functions**

Inside `StepReader`, after the existing `useState`/`useRef` declarations (after `mounted`), add:

```tsx
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredReader[]>([]);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [busyAdopt, setBusyAdopt] = useState<string | null>(null);
  const [prefillIp, setPrefillIp] = useState("");

  async function scanForReaders() {
    setScanning(true);
    setScanErr(null);
    try {
      const r = await fetch("/local/rfid/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const b = (await r.json().catch(() => null)) as
        | { readers?: DiscoveredReader[]; detail?: string }
        | null;
      if (r.ok && b) setDiscovered(b.readers ?? []);
      else setScanErr(b?.detail ?? "Scan failed.");
    } catch {
      setScanErr("Scan failed.");
    } finally {
      setScanning(false);
    }
  }

  async function adoptDiscovered(d: DiscoveredReader) {
    if (d.cred_index == null) {
      setPrefillIp(d.ip);
      setAdding(true);
      return;
    }
    setBusyAdopt(d.ip);
    setScanErr(null);
    try {
      const r = await fetch("/local/rfid/readers/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: d.ip, scheme: d.scheme, cred_index: d.cred_index }),
      });
      const b = (await r.json().catch(() => null)) as { detail?: string } | null;
      if (!r.ok) {
        setScanErr(b?.detail ?? "Could not add reader.");
        return;
      }
      setDiscovered((xs) => xs.filter((x) => x.ip !== d.ip));
      const list = await refresh();
      const added = list.find((x) => x.address === d.ip);
      if (added && isOnline(added)) select(added);
      else if (added) update({ readerName: added.name, endpointVerified: false });
    } catch {
      setScanErr("Could not add reader.");
    } finally {
      setBusyAdopt(null);
    }
  }
```

- [ ] **Step 3: Add a Scan button to the header**

Replace the header block:

```tsx
      <div className="flex items-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Connected readers
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="ml-auto flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-300 disabled:opacity-50"
        >
          <RotateCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
          Recheck
        </button>
      </div>
```

with:

```tsx
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Connected readers
        </p>
        <button
          type="button"
          onClick={scanForReaders}
          disabled={scanning}
          className="ml-auto flex h-8 items-center gap-1.5 rounded-lg border border-blue-800 bg-blue-950/40 px-3 text-xs text-blue-200 disabled:opacity-50"
        >
          <RotateCw className={"h-3.5 w-3.5 " + (scanning ? "animate-spin" : "")} />
          {scanning ? "Scanning…" : "Scan for readers"}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-300 disabled:opacity-50"
        >
          <RotateCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
          Recheck
        </button>
      </div>
```

- [ ] **Step 4: Render the discovered-readers list + scan error**

Immediately before the "Add reader" `<button>` (the one with `onClick={() => setAdding(true)}`), insert:

```tsx
        {scanErr && <p className="text-xs text-red-400">{scanErr}</p>}
        {discovered
          .filter((d) => !readers.some((r) => r.address === d.ip))
          .map((d) => (
            <button
              key={d.ip}
              type="button"
              onClick={() => adoptDiscovered(d)}
              disabled={busyAdopt === d.ip}
              className="flex items-center gap-3 rounded-xl border border-blue-900 bg-blue-950/30 px-4 py-3 text-left disabled:opacity-60"
            >
              <EthernetPort className="h-5 w-5 text-zinc-400" aria-hidden />
              <div>
                <div className="text-zinc-100">{d.name ?? d.ip}</div>
                <div className="font-mono text-xs text-zinc-500">
                  {d.ip}
                  <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                    {d.scheme}
                  </span>
                </div>
              </div>
              <span className="ml-auto text-xs font-semibold text-blue-300">
                {busyAdopt === d.ip
                  ? "Adding…"
                  : d.cred_index == null
                    ? "Add manually"
                    : "Add"}
              </span>
            </button>
          ))}
```

- [ ] **Step 5: Pass the prefill IP into `AddReaderPanel` and clear it on close**

Replace the `{adding && ( ... )}` block:

```tsx
      {adding && (
        <AddReaderPanel
          initialIp={prefillIp}
          onClose={() => {
            setAdding(false);
            setPrefillIp("");
          }}
          onAdded={async (name) => {
            setAdding(false);
            setPrefillIp("");
            const list = await refresh();
            const r = list.find((x) => x.name === name);
            if (r && isOnline(r)) select(r);
            else update({ readerName: name, endpointVerified: false });
          }}
        />
      )}
```

- [ ] **Step 6: Add the `initialIp` prop to `AddReaderPanel`**

Replace the `AddReaderPanel` signature and its `ip` state initializer:

```tsx
function AddReaderPanel({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const [ip, setIp] = useState("");
```

with:

```tsx
function AddReaderPanel({
  onClose,
  onAdded,
  initialIp = "",
}: {
  onClose: () => void;
  onAdded: (name: string) => void;
  initialIp?: string;
}) {
  const [ip, setIp] = useState(initialIp);
```

- [ ] **Step 7: Verify the build compiles**

Run (from `portal/`, ONE run, wait 1-2 min): `node_modules/.bin/tsc --noEmit`
Expected: no errors referencing `StepReader.tsx`.

- [ ] **Step 8: Commit**

```bash
git add portal/src/components/wizard/StepReader.tsx
git commit -m "feat(wizard): Step 2 scans for and adopts discovered Zebra readers"
```

---

## Self-Review notes

- **Spec coverage:** §1 enrichment + result shape (Task 1) ✓; §2 adopt endpoint with cred_index→password, 400/502 (Task 2) ✓; §3 wizard scan button + discovered list + adopt-on-pick + manual fallback prefill + filter-already-configured (Task 3) ✓; §4 reuse (Tasks 1-2) ✓; §5 safety: stop-at-first-success, cred_index-not-password (Task 1/2) ✓.
- **Type consistency:** backend reader dict keys `{ip, scheme, port, name, source, confirmed, cred_index}` match the TS `DiscoveredReader`; adopt request `{address, scheme, cred_index}` matches `AdoptReaderRequest`; `adoptDiscovered` posts those exact keys; `create_reader` is called with `ReaderCreateRequest(name, address, scheme, admin_username, admin_password)` — all existing fields.
- **Env caveat:** API tests import `app.rfid` directly and monkeypatch `rfid_status`/`rfid_mod` (no TestClient, no python-multipart). Portal gate is `tsc` (no component test runner) — single run.
- **Live verification (Pi):** confirm one of the seeded passwords actually logs into the FX9600 and that the scan returns the real name + a non-null `cred_index`; if all three fail, names stay null and readers fall back to the manual-add path.
