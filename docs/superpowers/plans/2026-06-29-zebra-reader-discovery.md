# Zebra Reader Network Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /local/rfid/scan` discover only confirmed Zebra RFID readers — scan ports 80 and 443, confirm each open host via a credential-free ZIOTC signature check, and return a normalized list the Add-Reader dialog renders.

**Architecture:** Two new functions in `api/app/rfid.py` — `_is_ziotc_reader` (credential-free confirm) and `discover_readers` (subnet scan + confirm + dedupe) — replace the raw open-port scan endpoint. The Readers-page dialog is updated to consume the new `readers` list. The result schema carries `source`/`name` fields so an mDNS discovery can merge in later without changing the contract.

**Tech Stack:** Python 3.13 / FastAPI / `requests` / `concurrent.futures` / pytest (API); Next 16 / React 19 / TypeScript (portal).

## Global Constraints

- Reader HTTP uses `requests` with `verify=False` (self-signed LAN certs) — keep it; suppress the urllib3 InsecureRequestWarning.
- No new dependencies (`requests`/`urllib3` already ship via `rfid_status`).
- Subnet discovery reuses `_primary_local_cidr()` and the `SCAN_MAX_HOSTS` (/22) cap, keeping the existing "subnet too large" (400) and "could not determine local subnet" (500) responses.
- Confirmation is credential-free; ports scanned are fixed at **80 and 443**; a reader open on both dedupes to one entry preferring **https/443**.
- Only confirmed readers are returned; open-but-unconfirmed hosts are dropped and their count logged (no silent caps).
- Result schema (verbatim): `{ "ip", "scheme", "port", "name": null, "source": "scan", "confirmed": true }`.
- Portal: straight ASCII quotes only (no curly quotes — they break compilation). No new field selector; manual IP entry stays.
- Spec: `docs/superpowers/specs/2026-06-29-zebra-reader-discovery-design.md`.

---

### Task 1: Credential-free ZIOTC signature check

**Files:**
- Modify: `api/app/rfid.py` (add `import requests`/`import urllib3` at the top with the other stdlib/third-party imports ~line 21; add constants near `SCAN_MAX_HOSTS` ~line 36; add the function near `_probe` ~line 323)
- Test: `api/tests/test_reader_discovery.py`

**Interfaces:**
- Produces: `_is_ziotc_reader(scheme: str, ip: str, timeout: float = ZIOTC_CONFIRM_TIMEOUT_SEC) -> bool`; constants `ZIOTC_CONFIRM_TIMEOUT_SEC: float`, `SCAN_PORTS: tuple = (80, 443)`.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_reader_discovery.py
"""Zebra reader discovery: signature confirm + scan orchestration."""
import requests

from app import rfid as rfid_mod
from app.rfid import _is_ziotc_reader


class _Resp:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


def test_confirms_on_auth_header_marker(monkeypatch):
    monkeypatch.setattr(rfid_mod.requests, "get",
                        lambda *a, **k: _Resp(500, "Authorization header missing!"))
    assert _is_ziotc_reader("http", "10.0.0.5") is True


def test_confirms_on_jwt_marker(monkeypatch):
    monkeypatch.setattr(rfid_mod.requests, "get",
                        lambda *a, **k: _Resp(401, "Invalid number of segments in jwt token; authorization required"))
    assert _is_ziotc_reader("https", "10.0.0.5") is True


def test_rejects_a_plain_web_page(monkeypatch):
    monkeypatch.setattr(rfid_mod.requests, "get",
                        lambda *a, **k: _Resp(200, "<html><body>Printer admin</body></html>"))
    assert _is_ziotc_reader("http", "10.0.0.5") is False


def test_rejects_on_connection_error(monkeypatch):
    def boom(*a, **k):
        raise requests.exceptions.ConnectionError("refused")
    monkeypatch.setattr(rfid_mod.requests, "get", boom)
    assert _is_ziotc_reader("https", "10.0.0.5") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_discovery.py -q`
Expected: FAIL — `ImportError: cannot import name '_is_ziotc_reader'`.

- [ ] **Step 3: Add imports and warning suppression**

At the top of `api/app/rfid.py`, in the third-party import group (with `import psycopg`), add:

```python
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
```

- [ ] **Step 4: Add constants**

Near the other `SCAN_*` constants in `api/app/rfid.py`:

```python
SCAN_PORTS = (80, 443)            # Zebra IoT Connector REST API (HTTP / HTTPS)
ZIOTC_CONFIRM_TIMEOUT_SEC = 1.0
# The ZIOTC server answers an unauthenticated /cloud/* call with this marker.
_ZIOTC_AUTH_MARKER = "authorization header missing"
```

- [ ] **Step 5: Implement `_is_ziotc_reader`**

Add near `_probe` in `api/app/rfid.py`:

```python
def _is_ziotc_reader(scheme: str, ip: str, timeout: float = ZIOTC_CONFIRM_TIMEOUT_SEC) -> bool:
    """Credential-free check that a host runs the Zebra ZIOTC REST API.

    Hits GET {scheme}://{ip}/cloud/version with no Authorization header. The
    ZIOTC server answers an unauthenticated /cloud/* call with a body that
    mentions "Authorization header missing" (the documented signature); some
    firmware phrases it as a jwt/authorization error. Returns False on any
    connection error, timeout, or non-matching response.
    """
    url = f"{scheme}://{ip}/cloud/version"
    try:
        resp = requests.get(url, verify=False, timeout=timeout, allow_redirects=False)
    except requests.RequestException:
        return False
    body = (resp.text or "").lower()
    if _ZIOTC_AUTH_MARKER in body:
        return True
    # Tolerate firmware variation: a jwt + authorization/token error also marks
    # the ZIOTC auth layer.
    if "jwt" in body and ("authorization" in body or "token" in body):
        return True
    return False
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_discovery.py -q`
Expected: PASS (4 passed).

- [ ] **Step 7: Commit**

```bash
git add api/app/rfid.py api/tests/test_reader_discovery.py
git commit -m "feat(rfid): credential-free ZIOTC reader signature check"
```

---

### Task 2: Discovery orchestration + endpoint

**Files:**
- Modify: `api/app/rfid.py` (replace the `ScanRequest` class ~line 80 and the `scan_for_readers` endpoint ~lines 338-382; remove the now-unused `SCAN_DEFAULT_PORT` constant ~line 33; add `discover_readers` + helper)
- Test: `api/tests/test_reader_discovery.py` (append)

**Interfaces:**
- Consumes: `_is_ziotc_reader`, `SCAN_PORTS`, `_probe`, `_primary_local_cidr`, `SCAN_MAX_HOSTS`, `SCAN_MAX_WORKERS`, `SCAN_PROBE_TIMEOUT_SEC` (existing).
- Produces: `discover_readers() -> dict` returning `{subnet, scanned_count, took_seconds, readers}` where each reader is `{ip, scheme, port, name, source, confirmed}`; `POST /local/rfid/scan` (no request body) returns that dict.

- [ ] **Step 1: Write the failing test (append to test_reader_discovery.py)**

```python
def test_discover_returns_only_confirmed_readers(monkeypatch):
    from app.rfid import discover_readers

    # /30 subnet -> hosts 10.0.0.1, 10.0.0.2
    monkeypatch.setattr(rfid_mod, "_primary_local_cidr", lambda: "10.0.0.0/30")

    open_map = {("10.0.0.1", 443): True, ("10.0.0.1", 80): True, ("10.0.0.2", 80): True}
    monkeypatch.setattr(rfid_mod, "_probe",
                        lambda host, port, timeout: host if open_map.get((host, port)) else None)

    # Only 10.0.0.1 is a real reader, and only over https.
    monkeypatch.setattr(rfid_mod, "_is_ziotc_reader",
                        lambda scheme, ip, timeout=1.0: ip == "10.0.0.1" and scheme == "https")

    out = discover_readers()
    assert out["scanned_count"] == 2
    assert out["readers"] == [
        {"ip": "10.0.0.1", "scheme": "https", "port": 443,
         "name": None, "source": "scan", "confirmed": True}
    ]


def test_discover_prefers_https_when_both_open(monkeypatch):
    from app.rfid import discover_readers
    monkeypatch.setattr(rfid_mod, "_primary_local_cidr", lambda: "10.0.0.0/30")
    monkeypatch.setattr(rfid_mod, "_probe",
                        lambda host, port, timeout: host if host == "10.0.0.1" else None)
    # Confirms on both schemes; dedupe must keep https only.
    monkeypatch.setattr(rfid_mod, "_is_ziotc_reader", lambda scheme, ip, timeout=1.0: ip == "10.0.0.1")
    out = discover_readers()
    assert len(out["readers"]) == 1
    assert out["readers"][0]["scheme"] == "https"
    assert out["readers"][0]["port"] == 443


def test_discover_no_subnet_raises_500(monkeypatch):
    from fastapi import HTTPException
    import pytest
    from app.rfid import discover_readers
    monkeypatch.setattr(rfid_mod, "_primary_local_cidr", lambda: None)
    with pytest.raises(HTTPException) as ei:
        discover_readers()
    assert ei.value.status_code == 500
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_discovery.py -q`
Expected: FAIL — `ImportError: cannot import name 'discover_readers'`.

- [ ] **Step 3: Remove `SCAN_DEFAULT_PORT` and the `ScanRequest` class**

Delete the line `SCAN_DEFAULT_PORT = 443    # Zebra IoT Connector REST API (HTTPS)` (it is now unused). Delete the `ScanRequest` class:

```python
class ScanRequest(BaseModel):
    port: int = Field(default=SCAN_DEFAULT_PORT, ge=1, le=65535)
```

- [ ] **Step 4: Add `discover_readers` and a scheme helper**

Add in `api/app/rfid.py` (e.g. just above the `@router.post("/scan")` endpoint):

```python
def _scheme_for_port(port: int) -> str:
    return "https" if port == 443 else "http"


def discover_readers() -> Dict[str, Any]:
    """Scan the Pi's subnet on ports 80 and 443 and return only hosts confirmed
    to be Zebra ZIOTC readers. Dedupes by IP, preferring https/443."""
    cidr = _primary_local_cidr()
    if not cidr:
        raise HTTPException(status_code=500, detail="could not determine local subnet")
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=f"bad CIDR {cidr}: {e}")

    hosts = [str(h) for h in net.hosts()]
    if len(hosts) > SCAN_MAX_HOSTS:
        raise HTTPException(
            status_code=400,
            detail=(f"subnet too large ({len(hosts)} hosts) — only /22 or smaller is scanned"),
        )

    start = time.time()

    # 1) Port scan both ports across all hosts.
    open_ports: Dict[str, set] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=SCAN_MAX_WORKERS) as ex:
        futures = {
            ex.submit(_probe, h, p, SCAN_PROBE_TIMEOUT_SEC): (h, p)
            for h in hosts for p in SCAN_PORTS
        }
        for fut in concurrent.futures.as_completed(futures):
            h, p = futures[fut]
            try:
                if fut.result():
                    open_ports.setdefault(h, set()).add(p)
            except Exception:
                pass

    # 2) Confirm each open host is a ZIOTC reader, preferring https/443.
    def _confirm(ip: str, ports: set) -> Optional[Dict[str, Any]]:
        for port in (443, 80):
            if port in ports and _is_ziotc_reader(_scheme_for_port(port), ip):
                return {
                    "ip": ip,
                    "scheme": _scheme_for_port(port),
                    "port": port,
                    "name": None,
                    "source": "scan",
                    "confirmed": True,
                }
        return None

    readers: List[Dict[str, Any]] = []
    unconfirmed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=SCAN_MAX_WORKERS) as ex:
        futures = {ex.submit(_confirm, ip, ports): ip for ip, ports in open_ports.items()}
        for fut in concurrent.futures.as_completed(futures):
            try:
                result = fut.result()
            except Exception:
                result = None
            if result:
                readers.append(result)
            else:
                unconfirmed += 1

    if unconfirmed:
        log.info(
            "reader scan: %d host(s) had a port open but failed the ZIOTC signature check",
            unconfirmed,
        )
    readers.sort(key=lambda r: tuple(int(p) for p in r["ip"].split(".")))
    return {
        "subnet": str(net),
        "scanned_count": len(hosts),
        "readers": readers,
        "took_seconds": round(time.time() - start, 1),
    }
```

- [ ] **Step 5: Replace the `scan_for_readers` endpoint**

Replace the existing `@router.post("/scan")` function body with the thin wrapper:

```python
@router.post("/scan")
def scan_for_readers() -> Dict[str, Any]:
    """Discover Zebra RFID readers on the Pi's primary subnet. Scans ports 80
    and 443 and returns only hosts confirmed via the credential-free ZIOTC
    signature check."""
    return discover_readers()
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_discovery.py -q`
Expected: PASS (7 passed).

- [ ] **Step 7: Commit**

```bash
git add api/app/rfid.py api/tests/test_reader_discovery.py
git commit -m "feat(rfid): discover only confirmed Zebra readers (scan 80+443)"
```

---

### Task 3: Add-Reader dialog renders confirmed readers

**Files:**
- Modify: `portal/src/app/config/rfid/readers/page.tsx` (the `ScanResult` type ~line 1556; `startScan` ~line 1609; `pickIp` ~line 1629; the scan button label ~line 1662; the results block ~lines 1668-1703; helper text ~lines 1645-1649)

**Interfaces:**
- Consumes: `POST /local/rfid/scan` returning `{subnet, scanned_count, took_seconds, readers: [{ip, scheme, port, name, source, confirmed}]}` from Task 2.

- [ ] **Step 1: Update the `ScanResult` type**

Replace:

```tsx
type ScanResult = {
  subnet: string;
  scanned_count: number;
  responded: Array<{ ip: string; port: number }>;
  took_seconds: number;
};
```

with:

```tsx
type DiscoveredReader = {
  ip: string;
  scheme: string;
  port: number;
  name: string | null;
  source: string;
  confirmed: boolean;
};

type ScanResult = {
  subnet: string;
  scanned_count: number;
  readers: DiscoveredReader[];
  took_seconds: number;
};
```

- [ ] **Step 2: Update `startScan` to send no port**

Replace the `fetch` body in `startScan`:

```tsx
      const res = await fetch("/local/rfid/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: Number(form.port) || 443 }),
      });
```

with:

```tsx
      const res = await fetch("/local/rfid/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
```

- [ ] **Step 3: Replace `pickIp` with `pickReader`**

Replace:

```tsx
  function pickIp(ip: string) {
    setForm((f) => ({ ...f, address: ip }));
  }
```

with:

```tsx
  function pickReader(r: DiscoveredReader) {
    setForm((f) => ({ ...f, address: r.ip, scheme: r.scheme, port: String(r.port) }));
  }
```

- [ ] **Step 4: Update the scan button label**

Replace:

```tsx
              {scanning
                ? "Scanning…"
                : `Scan port ${form.port || "443"} on local subnet`}
```

with:

```tsx
              {scanning ? "Scanning…" : "Scan local subnet for Zebra readers"}
```

- [ ] **Step 5: Update the helper text**

Replace:

```tsx
        <p className="mt-1 text-xs text-zinc-500">
          Default model is Zebra FX9600 — communicates via the IoT Connector
          REST API on HTTPS:443. Use Scan to find readers on this subnet, or
          enter the IP manually.
        </p>
```

with:

```tsx
        <p className="mt-1 text-xs text-zinc-500">
          Default model is Zebra FX9600 — communicates via the IoT Connector
          REST API. Use Scan to find Zebra readers on this subnet (HTTP or
          HTTPS), or enter the IP manually.
        </p>
```

- [ ] **Step 6: Update the results block**

Replace the whole `{scanResult && ( ... )}` block:

```tsx
          {scanResult && (
            <div className="mt-3 text-xs text-zinc-600">
              <p className="text-zinc-500">
                Scanned <span className="font-mono">{scanResult.subnet}</span>{" "}
                ({scanResult.scanned_count} hosts) in{" "}
                {scanResult.took_seconds}s — {scanResult.responded.length}{" "}
                responded.
              </p>
              {scanResult.responded.length === 0 ? (
                <p className="mt-1 italic text-zinc-400">
                  No reader-shaped hosts found on this port.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-zinc-200 overflow-hidden rounded border border-zinc-200 bg-white">
                  {scanResult.responded.map((r) => (
                    <li
                      key={r.ip}
                      className="flex items-center justify-between px-3 py-1.5"
                    >
                      <span className="font-mono text-zinc-800">
                        {r.ip}
                        <span className="ml-1 text-zinc-400">:{r.port}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => pickIp(r.ip)}
                        className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        Use this
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
```

with:

```tsx
          {scanResult && (
            <div className="mt-3 text-xs text-zinc-600">
              <p className="text-zinc-500">
                Scanned <span className="font-mono">{scanResult.subnet}</span>{" "}
                ({scanResult.scanned_count} hosts) in{" "}
                {scanResult.took_seconds}s — {scanResult.readers.length} Zebra
                reader{scanResult.readers.length === 1 ? "" : "s"} found.
              </p>
              {scanResult.readers.length === 0 ? (
                <p className="mt-1 italic text-zinc-400">
                  No Zebra readers found on this subnet.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-zinc-200 overflow-hidden rounded border border-zinc-200 bg-white">
                  {scanResult.readers.map((r) => (
                    <li
                      key={r.ip}
                      className="flex items-center justify-between px-3 py-1.5"
                    >
                      <span className="font-mono text-zinc-800">
                        {r.ip}
                        <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                          {r.scheme}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => pickReader(r)}
                        className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        Use this
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
```

- [ ] **Step 7: Verify the build compiles**

Run (from `portal/`, a SINGLE run — do not stack concurrent tsc runs, they starve each other; first run can take 1-2 min): `node_modules/.bin/tsc --noEmit`
Expected: no errors referencing `page.tsx` (`responded`, `pickIp` no longer referenced anywhere).

- [ ] **Step 8: Commit**

```bash
git add portal/src/app/config/rfid/readers/page.tsx
git commit -m "feat(portal): Add-Reader scan lists confirmed Zebra readers with scheme"
```

---

## Self-Review notes

- **Spec coverage:** §1 pipeline (Task 2) ✓, §2 schema (Task 2, exact dict) ✓, §3 signature check incl. fallback marker + unconfirmed log (Task 1 + Task 2) ✓, §4 endpoint shape change / drop port (Task 2) ✓, §5 UI scheme badge + address/scheme/port fill + helper text (Task 3) ✓. mDNS (A) intentionally out of scope; schema carries `source`/`name`.
- **Type consistency:** `discover_readers` returns `readers` with keys `ip/scheme/port/name/source/confirmed`; the TS `DiscoveredReader` mirrors them; `_is_ziotc_reader(scheme, ip, timeout=...)` signature matches the monkeypatch in Task 2's test and the call in `_confirm`.
- **Env caveat:** discovery tests import `app.rfid` directly (no FastAPI TestClient), so they don't need `python-multipart`. tsc is the portal gate (no React component test runner); run it once to avoid the starvation seen earlier this session.
- **Live verification (Pi):** confirm the FX9600's unauthenticated `/cloud/version` response actually contains "Authorization header missing"; if not, the logged unconfirmed-host count flags it and the marker in `_ZIOTC_AUTH_MARKER` / the jwt fallback is adjusted.
