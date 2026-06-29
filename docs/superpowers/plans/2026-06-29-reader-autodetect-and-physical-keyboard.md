# Reader Scheme Auto-Detect + Physical Keyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Make add-reader auto-detect the reader's scheme — try HTTPS, fall back to HTTP only on connection failure, never on a bad password — and persist what connected. (B) Let a physically-attached keyboard drive the same kiosk fields the on-screen keyboard edits.

**Architecture:** Part A adds typed login errors and a `connect_autodetect` helper in `api/app/rfid_status.py`, consumed by the `probe_reader` endpoint; the wizard persists the detected scheme. Part B adds a `usePhysicalKeyboard` hook inside `OnScreenKeyboard.tsx` built around a pure `applyPhysicalKey` reducer, so all three on-screen-keyboard surfaces gain physical input at once.

**Tech Stack:** Python 3.13 / FastAPI / `requests` / pytest (API); Next 16 / React 19 / TypeScript / vitest (portal).

## Global Constraints

- API DB access is via `psql` subprocess (no ORM) — do not introduce SQLAlchemy or async DB libs.
- Reader transport uses `requests` with `verify=False` (self-signed LAN certs) — keep this.
- New exceptions must subclass `RuntimeError` so existing `except Exception` callers in the poller are unaffected.
- `_base_url` already derives port from scheme (80/443) when port is empty or a standard port — do not pass an explicit port during auto-detect.
- Portal: no scheme/field selector is added anywhere; the on-screen keyboard stays visible and unchanged in appearance.
- Specs: `docs/superpowers/specs/2026-06-29-reader-scheme-autodetect-design.md`, `docs/superpowers/specs/2026-06-29-physical-keyboard-input-design.md`.

---

## Part A — Reader scheme auto-detect

### Task A1: Typed login errors in `_login`

**Files:**
- Modify: `api/app/rfid_status.py` (add exception classes near the top, ~line 60; change `_login` ~lines 289-339)
- Test: `api/tests/test_login_errors.py`

**Interfaces:**
- Produces: `ReaderTransportError(RuntimeError)`, `ReaderAuthError(RuntimeError)`; `_login(reader: dict) -> str` now raises `ReaderTransportError` on `requests.RequestException`, `ReaderAuthError` on HTTP 401/403, generic `RuntimeError` on other non-200 or non-JWT body.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_login_errors.py
"""_login maps reader failures to typed exceptions."""
import pytest
import requests

from app import rfid_status
from app.rfid_status import ReaderAuthError, ReaderTransportError, _login


class _Resp:
    def __init__(self, status_code=200, text="JWT Token: a.b.c", headers=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {"content-type": "text/plain"}

    def json(self):
        import json
        return json.loads(self.text)


_READER = {"address": "10.0.0.5", "scheme": "https", "admin_username": "admin", "admin_password": "pw"}


def test_transport_error_maps_to_reader_transport_error(monkeypatch):
    def boom(*a, **k):
        raise requests.exceptions.ConnectionError("refused")
    monkeypatch.setattr(rfid_status.requests, "get", boom)
    with pytest.raises(ReaderTransportError):
        _login(_READER)


def test_tls_handshake_failure_is_transport_error(monkeypatch):
    def boom(*a, **k):
        raise requests.exceptions.SSLError("WRONG_VERSION_NUMBER")
    monkeypatch.setattr(rfid_status.requests, "get", boom)
    with pytest.raises(ReaderTransportError):
        _login(_READER)


def test_http_401_maps_to_auth_error(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(status_code=401, text="unauthorized"))
    with pytest.raises(ReaderAuthError):
        _login(_READER)


def test_http_403_maps_to_auth_error(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(status_code=403, text="forbidden"))
    with pytest.raises(ReaderAuthError):
        _login(_READER)


def test_http_500_maps_to_generic_runtimeerror(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(status_code=500, text="boom"))
    with pytest.raises(RuntimeError) as ei:
        _login(_READER)
    assert not isinstance(ei.value, (ReaderAuthError, ReaderTransportError))


def test_success_returns_jwt(monkeypatch):
    monkeypatch.setattr(rfid_status.requests, "get", lambda *a, **k: _Resp(status_code=200, text="JWT Token: aa.bb.cc"))
    assert _login(_READER) == "aa.bb.cc"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_login_errors.py -q`
Expected: FAIL — `ImportError: cannot import name 'ReaderAuthError'`.

- [ ] **Step 3: Add the exception classes**

Add near the top of `api/app/rfid_status.py`, after the `log = logging.getLogger(__name__)` line:

```python
class ReaderTransportError(RuntimeError):
    """No HTTP response from the reader — connection refused, TLS handshake
    failure, or timeout. The only failure that triggers a scheme fallback."""


class ReaderAuthError(RuntimeError):
    """Reader was reachable but rejected the credentials (HTTP 401/403)."""
```

- [ ] **Step 4: Update `_login` to raise the typed errors**

In `_login`, change the transport `except` and the status-code check:

```python
    try:
        resp = requests.get(
            url,
            auth=(username, password),
            verify=False,
            timeout=LOGIN_TIMEOUT_SEC,
        )
    except requests.RequestException as e:
        raise ReaderTransportError(f"login transport error: {type(e).__name__}: {e}")

    if resp.status_code in (401, 403):
        raise ReaderAuthError(f"login HTTP {resp.status_code}: {resp.text[:200]}")
    if resp.status_code != 200:
        raise RuntimeError(f"login HTTP {resp.status_code}: {resp.text[:200]}")
```

Leave the rest of `_login` (token parsing, JWT-shape check raising plain `RuntimeError`) unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_login_errors.py -q`
Expected: PASS (6 passed).

- [ ] **Step 6: Commit**

```bash
git add api/app/rfid_status.py api/tests/test_login_errors.py
git commit -m "feat(rfid): typed login errors (transport vs auth vs generic)"
```

---

### Task A2: `connect_autodetect` helper

**Files:**
- Modify: `api/app/rfid_status.py` (add function after `_login`)
- Test: `api/tests/test_autodetect.py`

**Interfaces:**
- Consumes: `_login`, `ReaderTransportError`, `ReaderAuthError` from Task A1.
- Produces: `connect_autodetect(reader: dict, schemes=("https", "http")) -> tuple[str, str]` returning `(scheme, token)`. Falls back to the next scheme only on `ReaderTransportError`; re-raises `ReaderAuthError` and generic `RuntimeError`; raises `RuntimeError` if every scheme fails with a transport error.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_autodetect.py
"""connect_autodetect tries https then http, with the locked fallback rules."""
import pytest

from app import rfid_status
from app.rfid_status import ReaderAuthError, ReaderTransportError, connect_autodetect

_READER = {"address": "10.0.0.5", "admin_username": "admin", "admin_password": "pw"}


def _fake_login(results):
    """results: dict scheme -> token string or exception instance to raise."""
    calls = []

    def _login(reader):
        scheme = reader["scheme"]
        calls.append(scheme)
        outcome = results[scheme]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    _login.calls = calls
    return _login


def test_https_success_returns_https_and_skips_http(monkeypatch):
    fake = _fake_login({"https": "tok-https"})
    monkeypatch.setattr(rfid_status, "_login", fake)
    assert connect_autodetect(_READER) == ("https", "tok-https")
    assert fake.calls == ["https"]


def test_https_transport_error_falls_back_to_http(monkeypatch):
    fake = _fake_login({"https": ReaderTransportError("refused"), "http": "tok-http"})
    monkeypatch.setattr(rfid_status, "_login", fake)
    assert connect_autodetect(_READER) == ("http", "tok-http")
    assert fake.calls == ["https", "http"]


def test_https_auth_error_does_not_fall_back(monkeypatch):
    fake = _fake_login({"https": ReaderAuthError("401")})
    monkeypatch.setattr(rfid_status, "_login", fake)
    with pytest.raises(ReaderAuthError):
        connect_autodetect(_READER)
    assert fake.calls == ["https"]  # http never tried


def test_https_generic_error_does_not_fall_back(monkeypatch):
    fake = _fake_login({"https": RuntimeError("500")})
    monkeypatch.setattr(rfid_status, "_login", fake)
    with pytest.raises(RuntimeError):
        connect_autodetect(_READER)
    assert fake.calls == ["https"]


def test_both_transport_errors_raise_runtimeerror(monkeypatch):
    fake = _fake_login({"https": ReaderTransportError("a"), "http": ReaderTransportError("b")})
    monkeypatch.setattr(rfid_status, "_login", fake)
    with pytest.raises(RuntimeError):
        connect_autodetect(_READER)
    assert fake.calls == ["https", "http"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_autodetect.py -q`
Expected: FAIL — `ImportError: cannot import name 'connect_autodetect'`.

- [ ] **Step 3: Implement `connect_autodetect`**

Add immediately after `_login` in `api/app/rfid_status.py`:

```python
def connect_autodetect(reader: Dict[str, Any], schemes=("https", "http")):
    """Try each scheme in order; return (scheme, token) on first success.

    Falls back to the next scheme ONLY on a transport error (no HTTP response).
    A ReaderAuthError (bad password) or any other HTTP-level RuntimeError means
    the reader was reachable on that scheme, so it propagates immediately rather
    than being masked by a fallback. Raises RuntimeError if every scheme fails to
    connect.
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

(`ReaderAuthError` and generic `RuntimeError` are not caught, so they break out of the loop and propagate — exactly the desired no-fallback behavior.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_autodetect.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add api/app/rfid_status.py api/tests/test_autodetect.py
git commit -m "feat(rfid): connect_autodetect tries https then http on transport failure"
```

---

### Task A3: `probe_reader` endpoint uses auto-detect

**Files:**
- Modify: `api/app/rfid.py` (`probe_reader`, ~lines 449-466)
- Test: `api/tests/test_probe_autodetect.py`

**Interfaces:**
- Consumes: `connect_autodetect`, `ReaderAuthError` from Tasks A1/A2; `_get_status`.
- Produces: `POST /local/rfid/readers/probe` returns `{"ok": True, "scheme": <str>, "hostname": <str>, "status": <obj>}`; returns HTTP 401 on `ReaderAuthError`, HTTP 502 on any other failure.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_probe_autodetect.py
"""probe_reader returns the detected scheme and maps auth errors to 401.

Calls probe_reader directly (not via TestClient) so it does not require
python-multipart, which the FastAPI app import pulls in for other routes.
"""
import pytest
from fastapi import HTTPException

from app import rfid as rfid_mod
from app import rfid_status
from app.rfid import ReaderProbeRequest, probe_reader
from app.rfid_status import ReaderAuthError


def test_probe_returns_detected_scheme(monkeypatch):
    monkeypatch.setattr(rfid_status, "connect_autodetect", lambda reader: ("http", "tok"))
    monkeypatch.setattr(rfid_status, "_get_status", lambda reader, token: {"readerName": "Dock-1"})
    body = ReaderProbeRequest(address="10.0.0.5", password="pw")
    out = probe_reader(body)
    assert out["ok"] is True
    assert out["scheme"] == "http"
    assert out["hostname"] == "Dock-1"


def test_probe_auth_error_returns_401(monkeypatch):
    def boom(reader):
        raise ReaderAuthError("login HTTP 401")
    monkeypatch.setattr(rfid_status, "connect_autodetect", boom)
    body = ReaderProbeRequest(address="10.0.0.5", password="wrong")
    with pytest.raises(HTTPException) as ei:
        probe_reader(body)
    assert ei.value.status_code == 401


def test_probe_unreachable_returns_502(monkeypatch):
    def boom(reader):
        raise RuntimeError("could not reach reader over https/http")
    monkeypatch.setattr(rfid_status, "connect_autodetect", boom)
    body = ReaderProbeRequest(address="10.0.0.5", password="pw")
    with pytest.raises(HTTPException) as ei:
        probe_reader(body)
    assert ei.value.status_code == 502
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_probe_autodetect.py -q`
Expected: FAIL — `KeyError: 'scheme'` (current probe returns no `scheme`) and the 401 test fails (current code raises 502 for everything).

- [ ] **Step 3: Rewrite the body of `probe_reader`**

Replace the `try/except` and return in `probe_reader` (`api/app/rfid.py`) with:

```python
    from app import rfid_status  # noqa: PLC0415
    from app.rfid_status import ReaderAuthError  # noqa: PLC0415

    reader = {
        "address": body.address.strip(),
        "port": body.port,
        "admin_username": (body.admin_username or "admin").strip() or "admin",
        "admin_password": body.password or "",
    }
    try:
        scheme, token = rfid_status.connect_autodetect(reader)
        reader["scheme"] = scheme
        status = rfid_status._get_status(reader, token)
    except ReaderAuthError as e:
        log.warning("reader probe auth failure for %s: %s", reader["address"], e)
        raise HTTPException(status_code=401, detail="authentication failed — check admin password")
    except Exception as e:
        log.warning("reader probe failed for %s: %s", reader["address"], e)
        raise HTTPException(status_code=502, detail=f"could not reach reader: {e}")
    hostname = _extract_hostname(status) or reader["address"]
    return {"ok": True, "scheme": scheme, "hostname": hostname, "status": status}
```

(The `scheme` field on `ReaderProbeRequest` is now unused by this path; leave the model field for backward compatibility.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_probe_autodetect.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add api/app/rfid.py api/tests/test_probe_autodetect.py
git commit -m "feat(rfid): probe endpoint auto-detects scheme, 401 on bad password"
```

---

### Task A4: Wizard persists the detected scheme

**Files:**
- Modify: `portal/src/components/wizard/StepReader.tsx` (`connect`, ~lines 335-373; the helper text line ~410)

**Interfaces:**
- Consumes: probe response `{ hostname, scheme, detail }` from Task A3.

- [ ] **Step 1: Update the probe response type and create call**

In `connect()`, change the parsed probe type and the create body. Replace:

```tsx
      const pb = (await pr.json().catch(() => null)) as
        | { hostname?: string; detail?: string }
        | null;
      if (!pr.ok) {
        setError(pb?.detail ?? "Could not reach reader.");
        return;
      }
      const hostname = pb?.hostname || ip;
      const cr = await fetch("/local/rfid/readers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: hostname,
          address: ip,
          admin_password: pw,
          scheme: "https",
        }),
      });
```

with:

```tsx
      const pb = (await pr.json().catch(() => null)) as
        | { hostname?: string; scheme?: string; detail?: string }
        | null;
      if (!pr.ok) {
        setError(pb?.detail ?? "Could not reach reader.");
        return;
      }
      const hostname = pb?.hostname || ip;
      const cr = await fetch("/local/rfid/readers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: hostname,
          address: ip,
          admin_password: pw,
          scheme: pb?.scheme ?? "https",
        }),
      });
```

- [ ] **Step 2: Update the stale helper text**

Replace the helper line (currently mentions `https:443`):

```tsx
        <p className="mb-2 text-[11px] text-zinc-500">
          Name is read from the reader’s hostname on connect. admin user defaults to “admin”; https:443.
        </p>
```

with:

```tsx
        <p className="mb-2 text-[11px] text-zinc-500">
          Name is read from the reader’s hostname on connect. admin user defaults to “admin”; scheme is detected automatically (HTTPS, then HTTP).
        </p>
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd portal && npx tsc --noEmit`
Expected: no type errors from `StepReader.tsx`.

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/wizard/StepReader.tsx
git commit -m "feat(wizard): persist auto-detected reader scheme"
```

---

## Part B — Physical keyboard input

### Task B1: vitest setup + pure `applyPhysicalKey` reducer

**Files:**
- Modify: `portal/package.json` (add `test` script + devDeps)
- Create: `portal/vitest.config.ts`
- Create: `portal/src/components/physicalKey.ts`
- Test: `portal/src/components/physicalKey.test.ts`

**Interfaces:**
- Produces: `applyPhysicalKey(value: string, key: string, layout: "full" | "numeric", hasModifier: boolean): { value: string; enter: boolean; handled: boolean }`. Pure — no DOM. `handled` is true when the key was consumed (caller should `preventDefault`).

- [ ] **Step 1: Add vitest to the portal**

Add to `portal/package.json` scripts:

```json
    "test": "vitest run"
```

Then install dev deps:

Run: `cd portal && npm install -D vitest@^2`
Expected: vitest added to devDependencies.

- [ ] **Step 2: Create the vitest config**

```ts
// portal/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Write the failing test**

```ts
// portal/src/components/physicalKey.test.ts
import { describe, it, expect } from "vitest";
import { applyPhysicalKey } from "./physicalKey";

describe("applyPhysicalKey", () => {
  it("appends a printable char in full layout", () => {
    expect(applyPhysicalKey("ab", "c", "full", false)).toEqual({ value: "abc", enter: false, handled: true });
  });

  it("appends the cased char the browser provides (Shift handled natively)", () => {
    expect(applyPhysicalKey("a", "B", "full", false)).toEqual({ value: "aB", enter: false, handled: true });
  });

  it("backspace removes the last char", () => {
    expect(applyPhysicalKey("abc", "Backspace", "full", false)).toEqual({ value: "ab", enter: false, handled: true });
  });

  it("backspace on empty stays empty", () => {
    expect(applyPhysicalKey("", "Backspace", "full", false)).toEqual({ value: "", enter: false, handled: true });
  });

  it("enter signals submit without changing value", () => {
    expect(applyPhysicalKey("abc", "Enter", "full", false)).toEqual({ value: "abc", enter: true, handled: true });
  });

  it("numeric layout accepts digits and dot", () => {
    expect(applyPhysicalKey("10", ".", "numeric", false)).toEqual({ value: "10.", enter: false, handled: true });
    expect(applyPhysicalKey("1", "9", "numeric", false)).toEqual({ value: "19", enter: false, handled: true });
  });

  it("numeric layout rejects letters", () => {
    expect(applyPhysicalKey("10", "a", "numeric", false)).toEqual({ value: "10", enter: false, handled: false });
  });

  it("ignores keys pressed with a modifier", () => {
    expect(applyPhysicalKey("ab", "c", "full", true)).toEqual({ value: "ab", enter: false, handled: false });
  });

  it("ignores non-printable named keys", () => {
    expect(applyPhysicalKey("ab", "ArrowLeft", "full", false)).toEqual({ value: "ab", enter: false, handled: false });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd portal && npm test`
Expected: FAIL — cannot resolve `./physicalKey`.

- [ ] **Step 5: Implement the reducer**

```ts
// portal/src/components/physicalKey.ts
export type KeyLayout = "full" | "numeric";

export interface KeyResult {
  value: string;
  enter: boolean;
  handled: boolean;
}

const NUMERIC_RE = /^[0-9.]$/;

/**
 * Pure reducer for a physical key press against the value an OnScreenKeyboard
 * edits. `hasModifier` is true if Ctrl/Meta/Alt was held (such keys are
 * ignored). Shift is NOT a modifier here — the browser already folds it into a
 * cased single-character `key`.
 */
export function applyPhysicalKey(
  value: string,
  key: string,
  layout: KeyLayout,
  hasModifier: boolean,
): KeyResult {
  const unchanged = { value, enter: false, handled: false };
  if (hasModifier) return unchanged;
  if (key === "Enter") return { value, enter: true, handled: true };
  if (key === "Backspace") return { value: value.slice(0, -1), enter: false, handled: true };
  if (key.length !== 1) return unchanged; // named keys: arrows, Tab, F-keys, etc.
  if (layout === "numeric" && !NUMERIC_RE.test(key)) return unchanged;
  return { value: value + key, enter: false, handled: true };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd portal && npm test`
Expected: PASS (all `applyPhysicalKey` tests).

- [ ] **Step 7: Commit**

```bash
git add portal/package.json portal/package-lock.json portal/vitest.config.ts portal/src/components/physicalKey.ts portal/src/components/physicalKey.test.ts
git commit -m "feat(portal): add vitest + pure applyPhysicalKey reducer"
```

---

### Task B2: `usePhysicalKeyboard` hook in `OnScreenKeyboard`

**Files:**
- Modify: `portal/src/components/OnScreenKeyboard.tsx` (imports, add hook, call it once in the component)

**Interfaces:**
- Consumes: `applyPhysicalKey` from Task B1; the existing `OnScreenKeyboard` props `value`, `onChange`, `onEnter`, `layout`.

- [ ] **Step 1: Add imports**

At the top of `portal/src/components/OnScreenKeyboard.tsx`, add `useEffect` and `useRef` to the React import and import the reducer:

```tsx
import { useEffect, useRef, useState } from "react";
import { applyPhysicalKey } from "./physicalKey";
```

- [ ] **Step 2: Add the hook**

Add this above the `OnScreenKeyboard` component:

```tsx
function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
}

/**
 * While mounted, lets a physically-attached keyboard drive the same value the
 * on-screen keyboard edits. Scoped to whichever field is active because only
 * one OnScreenKeyboard is mounted at a time. Latest props are read through a
 * ref so the window listener is bound once.
 */
function usePhysicalKeyboard({
  value,
  onChange,
  onEnter,
  layout,
}: {
  value: string;
  onChange: (next: string) => void;
  onEnter?: () => void;
  layout: Layout;
}) {
  const ref = useRef({ value, onChange, onEnter, layout });
  ref.current = { value, onChange, onEnter, layout };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      const { value: v, onChange: oc, onEnter: oe, layout: lay } = ref.current;
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      const res = applyPhysicalKey(v, e.key, lay, hasModifier);
      if (!res.handled) return;
      e.preventDefault();
      if (res.enter) {
        oe?.();
      } else if (res.value !== v) {
        oc(res.value);
      } else if (e.key === "Backspace") {
        oc(res.value); // keep state consistent on empty-backspace
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
```

- [ ] **Step 3: Call the hook in the component**

Inside `OnScreenKeyboard`, right after the existing `const [shift, setShift] = useState(false);` / `const [sym, setSym] = useState(false);` lines, add:

```tsx
  usePhysicalKeyboard({ value, onChange, onEnter, layout });
```

- [ ] **Step 4: Verify the build compiles**

Run: `cd portal && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Manual verification on the kiosk (documented, run on the Pi)**

With a USB keyboard attached: open the wizard add-reader step, tap the `Reader IP` field, type digits and `.` on the physical keyboard → value updates; tap `Password`, type a mixed-case password → updates; press Enter → connects. Repeat on the network wifi-password and static-IP screens.

- [ ] **Step 6: Commit**

```bash
git add portal/src/components/OnScreenKeyboard.tsx
git commit -m "feat(portal): physical keyboard drives active on-screen field"
```

---

## Self-Review notes

- **Spec A coverage:** typed errors (A1) ✓, autodetect helper + fallback rules (A2) ✓, probe returns scheme + 401/502 mapping (A3) ✓, wizard persists scheme (A4) ✓. Runtime poller unchanged (uses stored scheme) — no task needed, by design.
- **Spec B coverage:** pure reducer + layout filter + modifier/named-key handling (B1) ✓, hook inside OnScreenKeyboard with ref + editable-target guard + preventDefault (B2) ✓. All three surfaces covered transitively because they share `OnScreenKeyboard`.
- **Env caveat:** FastAPI `TestClient` requires `python-multipart`, absent on the current dev Mac; Part A tests call functions directly to avoid that dependency. If running the full app test suite, `pip install python-multipart` first.
- **Live verification (Pi):** confirm FX9600 bad-password status is 401/403 (adjust A1 if not), and that auto-detect persists the scheme the reader actually serves.
