# RFID Reader Start/Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-reader Start/Stop action button to `/config/rfid/readers` that controls Zebra reader runtime and reflects live state on every page tick.

**Architecture:** Three new backend endpoints on `/local/rfid` (bulk runtime fetch + per-reader start/stop), three new methods on `ZebraIoTClient` (`get_runtime`, `start`, `stop`), and a row-level action button on the readers page driven by a `runtime: Record<id, RuntimeState>` map fetched in parallel with the existing list call every 10s.

**Tech Stack:** FastAPI + psycopg + requests (api), Next.js 15 + React 19 + Tailwind (portal), pytest with FastAPI TestClient.

**Reference spec:** `docs/superpowers/specs/2026-06-04-rfid-reader-start-stop-design.md`

**Project is not a git repo.** Skip the `git commit` step at the end of each task — flag completion in the working directory instead.

---

## File Structure

- **Create:** `api/tests/test_zebra_iot.py` — unit tests for new client methods with mocked `requests.request`.
- **Create:** `api/tests/test_rfid_runtime.py` — endpoint tests for runtime + start + stop routes; mocks `ZebraIoTClient` and `_psql_json`.
- **Modify:** `api/app/zebra_iot.py` — add `_post_action`, `get_runtime`, `start`, `stop`.
- **Modify:** `api/app/rfid.py` — add bulk runtime + start + stop routes; reuse `_get_reader_row`.
- **Modify:** `portal/src/app/config/rfid/readers/page.tsx` — add `runtime` + `busyRuntime` state, widen `tick()`, add row Start/Stop button + handlers.

---

## Task 1: ZebraIoTClient — `get_runtime`, `start`, `stop`

**Files:**
- Create: `api/tests/test_zebra_iot.py`
- Modify: `api/app/zebra_iot.py`

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_zebra_iot.py
from unittest.mock import patch, MagicMock

import pytest

from app.zebra_iot import ZebraIoTClient


def _client() -> ZebraIoTClient:
    c = ZebraIoTClient(host="10.0.0.5", port=80, username="admin", password="pw")
    c._token = "header.payload.sig"  # skip login
    return c


def _resp(status: int, json_body=None, text="") -> MagicMock:
    r = MagicMock()
    r.status_code = status
    r.content = b"x" if (json_body is not None or text) else b""
    r.json.return_value = json_body if json_body is not None else {}
    r.text = text
    r.raise_for_status = MagicMock()
    if status >= 400:
        r.raise_for_status.side_effect = Exception(f"HTTP {status}")
    return r


def test_get_runtime_uses_bearer_and_parses_json():
    client = _client()
    with patch("app.zebra_iot.requests.request") as req:
        req.return_value = _resp(200, json_body={"running": True})
        out = client.get_runtime()
    assert out == {"running": True}
    args, kwargs = req.call_args
    assert args[0] == "GET"
    assert args[1] == "http://10.0.0.5:80/cloud/runtime"
    assert kwargs["headers"]["Authorization"] == "Bearer header.payload.sig"


def test_start_posts_with_bearer():
    client = _client()
    with patch("app.zebra_iot.requests.request") as req:
        req.return_value = _resp(200, json_body={"ok": True})
        client.start()
    args, kwargs = req.call_args
    assert args[0] == "POST"
    assert args[1] == "http://10.0.0.5:80/cloud/start"
    assert kwargs["headers"]["Authorization"] == "Bearer header.payload.sig"


def test_stop_posts_with_bearer():
    client = _client()
    with patch("app.zebra_iot.requests.request") as req:
        req.return_value = _resp(200, json_body={"ok": True})
        client.stop()
    args, kwargs = req.call_args
    assert args[0] == "POST"
    assert args[1] == "http://10.0.0.5:80/cloud/stop"


def test_post_action_retries_after_401():
    client = _client()
    # 1st call: action 401. 2nd: re-login 200 returning a JWT-ish text.
    # 3rd: action 200.
    login_resp = _resp(200)
    login_resp.headers = {"content-type": "text/plain"}
    login_resp.text = "JWT Token: a.b.c"
    with patch("app.zebra_iot.requests.request") as req, \
         patch("app.zebra_iot.requests.get") as login:
        req.side_effect = [_resp(401), _resp(200, json_body={"ok": True})]
        login.return_value = login_resp
        client._token = None  # force a fresh login on first call
        # Pre-stage a token so first call fires action immediately
        client._token = "stale.token.sig"
        out = client.start()
    assert out == {"ok": True}
    # Action was retried exactly twice; login happened once between
    assert req.call_count == 2
    assert login.call_count == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `api/`:
```bash
cd /Users/jrh1812/Desktop/StackPI_v2/api && python -m pytest tests/test_zebra_iot.py -v
```
Expected: FAIL — `AttributeError: 'ZebraIoTClient' object has no attribute 'get_runtime'`

- [ ] **Step 3: Implement the methods**

Add to `api/app/zebra_iot.py`, after the existing `set_config` method (before `_request_json`):

```python
    def get_runtime(self) -> Any:
        """`GET /cloud/runtime` — current reading runtime state.

        Shape is firmware-dependent; we return the parsed body verbatim and let
        the caller decide what counts as 'running'.
        """
        return self.get_json("/cloud/runtime")

    def start(self) -> Any:
        """`POST /cloud/start` — begin reading tags. Returns parsed body or None."""
        return self._post_action("/cloud/start")

    def stop(self) -> Any:
        """`POST /cloud/stop` — stop reading tags. Returns parsed body or None."""
        return self._post_action("/cloud/stop")

    def _post_action(self, path: str) -> Any:
        """POST with bearer auth, no body, no content-type. Re-logins once on 401.
        Returns parsed JSON, or response text, or None on empty body."""
        resp = self._request("POST", path)
        resp.raise_for_status()
        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return resp.text
```

Note: `_post_action` reuses the existing `_request` helper (which already handles bearer + 401 retry for body-less requests). No new auth plumbing.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/jrh1812/Desktop/StackPI_v2/api && python -m pytest tests/test_zebra_iot.py -v
```
Expected: PASS (4 tests).

- [ ] **Step 5: Mark complete** (no git — not a repo)

---

## Task 2: Bulk runtime endpoint — `GET /local/rfid/readers/runtime`

**Files:**
- Create: `api/tests/test_rfid_runtime.py`
- Modify: `api/app/rfid.py`

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_rfid_runtime.py
from unittest.mock import patch, MagicMock

import requests
from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def _fake_enabled_readers(rows):
    """Patch _psql_json so the runtime route sees `rows` as the enabled set.

    The route currently has two psql calls in different shapes; the first is
    a jsonb_agg of enabled readers, the second (if any) is auxiliary. We make
    the patch tolerant by matching on the SQL containing "WHERE enabled".
    """
    def _impl(sql, *args, **kwargs):
        if "WHERE enabled" in sql or "enabled = true" in sql:
            return rows
        return None
    return _impl


def test_runtime_bulk_returns_per_reader_state():
    rows = [
        {"id": 1, "scheme": "http", "address": "10.0.0.5", "port": 80,
         "admin_username": "admin", "admin_password": "pw"},
        {"id": 2, "scheme": "http", "address": "10.0.0.6", "port": 80,
         "admin_username": "admin", "admin_password": "pw"},
    ]
    fake_client = MagicMock()
    fake_client.get_runtime.return_value = {"running": True}

    with patch("app.rfid._psql_json", side_effect=_fake_enabled_readers(rows)), \
         patch("app.rfid.ZebraIoTClient", return_value=fake_client):
        resp = client.get("/local/rfid/readers/runtime")

    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {"1", "2"}
    for k in ("1", "2"):
        assert body[k]["running"] is True
        assert body[k]["raw"] == {"running": True}
        assert body[k]["error"] is None


def test_runtime_bulk_isolates_failures():
    rows = [
        {"id": 1, "scheme": "http", "address": "10.0.0.5", "port": 80,
         "admin_username": "admin", "admin_password": "pw"},
        {"id": 2, "scheme": "http", "address": "10.0.0.6", "port": 80,
         "admin_username": "admin", "admin_password": "pw"},
    ]

    def fake_ctor(*a, **kw):
        host = kw.get("host")
        c = MagicMock()
        if host == "10.0.0.5":
            c.get_runtime.side_effect = requests.ConnectionError("boom")
        else:
            c.get_runtime.return_value = {"running": False}
        return c

    with patch("app.rfid._psql_json", side_effect=_fake_enabled_readers(rows)), \
         patch("app.rfid.ZebraIoTClient", side_effect=fake_ctor):
        resp = client.get("/local/rfid/readers/runtime")

    assert resp.status_code == 200
    body = resp.json()
    assert body["1"]["running"] is None
    assert body["1"]["raw"] is None
    assert "ConnectionError" in body["1"]["error"]
    assert body["2"]["running"] is False
    assert body["2"]["raw"] == {"running": False}
    assert body["2"]["error"] is None


def test_runtime_bulk_empty_when_no_enabled():
    with patch("app.rfid._psql_json", side_effect=_fake_enabled_readers([])):
        resp = client.get("/local/rfid/readers/runtime")
    assert resp.status_code == 200
    assert resp.json() == {}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/jrh1812/Desktop/StackPI_v2/api && python -m pytest tests/test_rfid_runtime.py -v
```
Expected: FAIL — 404 on `/local/rfid/readers/runtime`.

- [ ] **Step 3: Implement the endpoint**

Add to `api/app/rfid.py`. Insert after the existing `@router.post("/scan")` block (before the `_get_reader_row` helper).

First, add module-level constants near the existing scan constants (around line 28):

```python
RUNTIME_TIMEOUT_SEC = 8.0
RUNTIME_MAX_CONCURRENCY = 5
```

Then add the route and helper. The route is registered with the exact path `/readers/runtime` — FastAPI matches static routes before parameterised `/readers/{id}`, so order versus the existing `@router.get("/readers")` etc. does not matter, but for readability place the new code immediately after `@router.post("/scan")`:

```python
def _runtime_for_one(reader: Dict[str, Any]) -> Dict[str, Any]:
    """Live-fetch /cloud/runtime for one enabled reader. Never raises;
    failures are returned as {"running": None, "raw": None, "error": "<short>"}.
    """
    from app.zebra_iot import ZebraIoTClient  # noqa: PLC0415 — avoid import cycle

    scheme = reader.get("scheme") or "http"
    port_val = reader.get("port")
    try:
        port = int(port_val) if port_val is not None else (80 if scheme == "http" else 443)
    except (TypeError, ValueError):
        port = 80 if scheme == "http" else 443

    address = reader.get("address") or ""
    if not address:
        return {"running": None, "raw": None, "error": "reader has no address"}

    client = ZebraIoTClient(
        host=address,
        port=port,
        username=reader.get("admin_username") or "admin",
        password=reader.get("admin_password") or "",
        scheme=scheme,
        timeout=RUNTIME_TIMEOUT_SEC,
    )
    try:
        raw = client.get_runtime()
    except Exception as e:  # noqa: BLE001 — we want any reader-side error captured
        if isinstance(e, requests.exceptions.HTTPError) and e.response is not None:
            short = f"HTTP {e.response.status_code}: {e.response.text[:200]}"
        else:
            short = f"{type(e).__name__}: {e}"
        return {"running": None, "raw": None, "error": short}

    return {"running": _interpret_running(raw), "raw": raw, "error": None}


def _interpret_running(raw: Any) -> Optional[bool]:
    """Best-effort: decide whether /cloud/runtime says 'reading'.
    Returns True / False if confident, None if the shape is unknown.

    Tolerant of multiple firmware shapes: the response may be a dict with
    `running` / `state` / `status`, or a string. Anything we can't parse
    becomes None and the UI falls through to the disabled-button branch.
    """
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("running", "started", "active", "inventory", "on", "true"):
            return True
        if s in ("stopped", "idle", "off", "false"):
            return False
        return None
    if isinstance(raw, dict):
        for key in ("running", "isRunning", "active"):
            v = raw.get(key)
            if isinstance(v, bool):
                return v
        for key in ("state", "status", "mode"):
            v = raw.get(key)
            if isinstance(v, str):
                inner = _interpret_running(v)
                if inner is not None:
                    return inner
    return None


@router.get("/readers/runtime")
def readers_runtime() -> Dict[str, Dict[str, Any]]:
    """Bulk live-fetch /cloud/runtime for every enabled reader in parallel.

    Returns a map keyed by stringified reader id (JSON object keys are strings)
    with shape {running, raw, error}. Always HTTP 200 unless DB enumeration fails.
    """
    rows = _psql_json(
        """
        SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
        FROM (
          SELECT id, scheme, address, port,
                 admin_username, admin_password
          FROM local_rfid_readers
          WHERE enabled = true
        ) r
        """
    )
    if rows is None:
        raise HTTPException(status_code=500, detail="failed to enumerate readers")
    if not rows:
        return {}

    out: Dict[str, Dict[str, Any]] = {}
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=RUNTIME_MAX_CONCURRENCY,
        thread_name_prefix="rfid-runtime",
    ) as ex:
        futures = {ex.submit(_runtime_for_one, r): r for r in rows}
        for fut in concurrent.futures.as_completed(futures):
            r = futures[fut]
            try:
                state = fut.result()
            except Exception as e:  # defensive — _runtime_for_one shouldn't raise
                state = {"running": None, "raw": None, "error": f"{type(e).__name__}: {e}"}
            out[str(r["id"])] = state
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/jrh1812/Desktop/StackPI_v2/api && python -m pytest tests/test_rfid_runtime.py -v
```
Expected: PASS (3 tests).

- [ ] **Step 5: Mark complete**

---

## Task 3: Start + Stop endpoints

**Files:**
- Modify: `api/app/rfid.py`
- Modify: `api/tests/test_rfid_runtime.py`

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_rfid_runtime.py`:

```python
def test_start_calls_cloud_start_then_returns_runtime():
    reader_row = {
        "id": 7, "scheme": "http", "address": "10.0.0.9", "port": 80,
        "admin_username": "admin", "admin_password": "pw",
    }

    def fake_psql(sql, *a, **kw):
        if "WHERE id =" in sql or "WHERE id=" in sql:
            return [reader_row]
        return None

    fake_client = MagicMock()
    fake_client.start.return_value = None
    fake_client.get_runtime.return_value = {"running": True}

    with patch("app.rfid._psql_json", side_effect=fake_psql), \
         patch("app.rfid.ZebraIoTClient", return_value=fake_client):
        resp = client.post("/local/rfid/readers/7/start")

    assert resp.status_code == 200
    body = resp.json()
    assert body == {"running": True, "raw": {"running": True}, "error": None}
    fake_client.start.assert_called_once_with()
    fake_client.get_runtime.assert_called_once_with()


def test_start_propagates_reader_failure_as_502():
    reader_row = {
        "id": 7, "scheme": "http", "address": "10.0.0.9", "port": 80,
        "admin_username": "admin", "admin_password": "pw",
    }

    def fake_psql(sql, *a, **kw):
        if "WHERE id =" in sql or "WHERE id=" in sql:
            return [reader_row]
        return None

    fake_client = MagicMock()
    fake_client.start.side_effect = requests.ConnectionError("boom")

    with patch("app.rfid._psql_json", side_effect=fake_psql), \
         patch("app.rfid.ZebraIoTClient", return_value=fake_client):
        resp = client.post("/local/rfid/readers/7/start")

    assert resp.status_code == 502
    assert "ConnectionError" in resp.json()["detail"]


def test_start_returns_404_for_unknown_reader():
    with patch("app.rfid._psql_json", return_value=[]):
        resp = client.post("/local/rfid/readers/999/start")
    assert resp.status_code == 404


def test_stop_calls_cloud_stop_then_returns_runtime():
    reader_row = {
        "id": 7, "scheme": "http", "address": "10.0.0.9", "port": 80,
        "admin_username": "admin", "admin_password": "pw",
    }

    def fake_psql(sql, *a, **kw):
        if "WHERE id =" in sql or "WHERE id=" in sql:
            return [reader_row]
        return None

    fake_client = MagicMock()
    fake_client.stop.return_value = None
    fake_client.get_runtime.return_value = {"running": False}

    with patch("app.rfid._psql_json", side_effect=fake_psql), \
         patch("app.rfid.ZebraIoTClient", return_value=fake_client):
        resp = client.post("/local/rfid/readers/7/stop")

    assert resp.status_code == 200
    body = resp.json()
    assert body == {"running": False, "raw": {"running": False}, "error": None}
    fake_client.stop.assert_called_once_with()


def test_stop_propagates_reader_failure_as_502():
    reader_row = {
        "id": 7, "scheme": "http", "address": "10.0.0.9", "port": 80,
        "admin_username": "admin", "admin_password": "pw",
    }

    def fake_psql(sql, *a, **kw):
        if "WHERE id =" in sql or "WHERE id=" in sql:
            return [reader_row]
        return None

    fake_client = MagicMock()
    fake_client.stop.side_effect = requests.ConnectionError("boom")

    with patch("app.rfid._psql_json", side_effect=fake_psql), \
         patch("app.rfid.ZebraIoTClient", return_value=fake_client):
        resp = client.post("/local/rfid/readers/7/stop")

    assert resp.status_code == 502
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/jrh1812/Desktop/StackPI_v2/api && python -m pytest tests/test_rfid_runtime.py -v -k "start or stop"
```
Expected: FAIL — endpoint not registered (404 on POSTs).

- [ ] **Step 3: Implement the routes**

Append to `api/app/rfid.py`, after `readers_runtime`:

```python
def _run_reader_action(reader_id: int, action: str) -> Dict[str, Any]:
    """Shared body for start/stop routes. action is "start" or "stop"."""
    from app.zebra_iot import ZebraIoTClient  # noqa: PLC0415

    reader = _get_reader_row(reader_id)
    if reader is None:
        raise HTTPException(status_code=404, detail="reader not found")

    address = reader.get("address")
    if not address:
        raise HTTPException(status_code=400, detail="reader has no address")

    scheme = reader.get("scheme") or "http"
    port_val = reader.get("port")
    try:
        port = int(port_val) if port_val is not None else (80 if scheme == "http" else 443)
    except (TypeError, ValueError):
        port = 80 if scheme == "http" else 443

    client_ = ZebraIoTClient(
        host=address,
        port=port,
        username=reader.get("admin_username") or "admin",
        password=reader.get("admin_password") or "",
        scheme=scheme,
        timeout=RUNTIME_TIMEOUT_SEC,
    )

    try:
        if action == "start":
            client_.start()
        else:
            client_.stop()
        raw = client_.get_runtime()
    except Exception as e:  # noqa: BLE001
        if isinstance(e, requests.exceptions.HTTPError) and e.response is not None:
            short = f"HTTP {e.response.status_code}: {e.response.text[:200]}"
        else:
            short = f"{type(e).__name__}: {e}"
        raise HTTPException(status_code=502, detail=short)

    return {"running": _interpret_running(raw), "raw": raw, "error": None}


@router.post("/readers/{reader_id}/start")
def start_reader(reader_id: int) -> Dict[str, Any]:
    return _run_reader_action(int(reader_id), "start")


@router.post("/readers/{reader_id}/stop")
def stop_reader(reader_id: int) -> Dict[str, Any]:
    return _run_reader_action(int(reader_id), "stop")
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/jrh1812/Desktop/StackPI_v2/api && python -m pytest tests/test_rfid_runtime.py -v
```
Expected: PASS (8 tests total in this file).

Also run the full suite to confirm no regressions:
```bash
cd /Users/jrh1812/Desktop/StackPI_v2/api && python -m pytest -v
```
Expected: all green.

- [ ] **Step 5: Mark complete**

---

## Task 4: Frontend — runtime state + parallel tick fetch

**Files:**
- Modify: `portal/src/app/config/rfid/readers/page.tsx`

- [ ] **Step 1: Add `RuntimeState` type next to existing types**

After the existing `Counts` and `Payload` type aliases (around line 58), add:

```ts
type RuntimeState = { running: boolean | null; error: string | null };
type RuntimeMap = Record<number, RuntimeState>;
```

- [ ] **Step 2: Add state hooks inside `RFIDReadersPage`**

After the existing `useState` block (around line 92, after `banner`), add:

```ts
  const [runtime, setRuntime] = useState<RuntimeMap>({});
  const [busyRuntime, setBusyRuntime] = useState<Record<number, boolean>>({});
```

- [ ] **Step 3: Widen `tick()` to fetch both endpoints**

Replace the existing `useEffect`'s `tick()` body (around lines 95-103):

```ts
    async function tick() {
      const [listRes, runtimeRes] = await Promise.allSettled([
        fetch("/local/rfid/readers", { cache: "no-store" }),
        fetch("/local/rfid/readers/runtime", { cache: "no-store" }),
      ]);
      if (cancelled) return;

      if (listRes.status === "fulfilled" && listRes.value.ok) {
        try {
          setData((await listRes.value.json()) as Payload);
        } catch { /* keep last good */ }
      }

      if (runtimeRes.status === "fulfilled" && runtimeRes.value.ok) {
        try {
          const m = (await runtimeRes.value.json()) as Record<string, RuntimeState>;
          const next: RuntimeMap = {};
          for (const [k, v] of Object.entries(m)) {
            next[Number(k)] = v;
          }
          setRuntime(next);
        } catch { /* keep last good */ }
      }
    }
```

- [ ] **Step 4: Also update `refreshNow()`**

Replace the existing `refreshNow()` (around lines 117-122):

```ts
  async function refreshNow() {
    try {
      const [listRes, runtimeRes] = await Promise.allSettled([
        fetch("/local/rfid/readers", { cache: "no-store" }),
        fetch("/local/rfid/readers/runtime", { cache: "no-store" }),
      ]);
      if (listRes.status === "fulfilled" && listRes.value.ok) {
        setData((await listRes.value.json()) as Payload);
      }
      if (runtimeRes.status === "fulfilled" && runtimeRes.value.ok) {
        const m = (await runtimeRes.value.json()) as Record<string, RuntimeState>;
        const next: RuntimeMap = {};
        for (const [k, v] of Object.entries(m)) next[Number(k)] = v;
        setRuntime(next);
      }
    } catch {}
  }
```

- [ ] **Step 5: Run a build to verify types**

```bash
cd /Users/jrh1812/Desktop/StackPI_v2/portal && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Mark complete**

---

## Task 5: Frontend — Start/Stop button + click handlers

**Files:**
- Modify: `portal/src/app/config/rfid/readers/page.tsx`

- [ ] **Step 1: Add click handlers**

After `confirmDeleteReader` (around line 215), add:

```ts
  async function postReaderAction(reader: Reader, verb: "start" | "stop") {
    setBusyRuntime((b) => ({ ...b, [reader.id]: true }));
    try {
      const res = await fetch(
        `/local/rfid/readers/${reader.id}/${verb}`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as RuntimeState | { detail?: string } | null;
      if (res.ok && body && "running" in body) {
        setRuntime((rt) => ({ ...rt, [reader.id]: body as RuntimeState }));
        flash("success", `${verb === "start" ? "Started" : "Stopped"} reader “${reader.name}”.`);
      } else {
        const detail = body && "detail" in body ? body.detail : undefined;
        flash("error", detail ?? `Failed to ${verb} reader.`);
      }
    } finally {
      setBusyRuntime((b) => ({ ...b, [reader.id]: false }));
    }
  }
```

- [ ] **Step 2: Add the row action button**

In the row's Actions cell (around line 322, inside `<div className="inline-flex gap-1">`), insert a button **before** Edit:

```tsx
                      <RuntimeButton
                        reader={r}
                        state={runtime[r.id]}
                        busy={!!busyRuntime[r.id]}
                        onClick={(verb) => postReaderAction(r, verb)}
                      />
                      <button
                        type="button"
                        onClick={() => setEditTarget(r)}
                        className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        Edit
                      </button>
                      ...existing Delete button stays...
```

- [ ] **Step 3: Add the `RuntimeButton` component**

Add at the bottom of the file (after the final closing brace of `RFIDReadersPage` but before any other component definitions — anywhere outside `RFIDReadersPage` is fine):

```tsx
function RuntimeButton({
  reader,
  state,
  busy,
  onClick,
}: {
  reader: Reader;
  state: RuntimeState | undefined;
  busy: boolean;
  onClick: (verb: "start" | "stop") => void;
}) {
  if (!reader.enabled) return null;

  const running = state?.running;
  const error = state?.error;

  if (running === true) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onClick("stop")}
        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
        title="Stop reading tags"
      >
        {busy && <Spinner />} Stop
      </button>
    );
  }

  if (running === false) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onClick("start")}
        className="inline-flex items-center gap-1 rounded-md border border-green-200 bg-white px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-60"
        title="Start reading tags"
      >
        {busy && <Spinner />} Start
      </button>
    );
  }

  // running == null — unknown / error
  return (
    <button
      type="button"
      disabled
      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-400"
      title={error ?? "Status unknown"}
    >
      Start
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3 w-3 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M4 12a8 8 0 0 1 8-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/jrh1812/Desktop/StackPI_v2/portal && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Mark complete**

---

## Task 6: Manual verification

- [ ] **Step 1: Restart the api on the Pi (or wherever it runs in dev) and refresh the page.**

- [ ] **Step 2: Confirm the four UI states:**
  1. Running reader → red Stop button.
  2. Click Stop → spinner, settles into green Start.
  3. Click Start → spinner, settles into red Stop.
  4. Break a reader's reachability (e.g., temporarily change `port` in `local_rfid_readers` to a dead port) → button renders disabled "Start" with hover tooltip showing the error.

- [ ] **Step 3: Confirm no regressions** — Details / Edit / Delete still work, status badge + last-poll column still update.

- [ ] **Step 4: Restore any test-mutated DB rows.**

---

## Out of scope (do not implement)

- Background poller changes — `reader_poller.py` keeps writing `last_status` / `last_error` and that's intended.
- DB schema changes.
- Frontend Jest/RTL test scaffolding.
- Live-reader integration tests in CI.
