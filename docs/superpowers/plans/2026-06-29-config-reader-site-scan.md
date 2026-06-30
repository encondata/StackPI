# Set Reader Site + Scan Type from /config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator set the reader's move-site (source/destination) and scan type from Config → RFID → Settings, reusing the existing reader-settings save and persisting the values durably so the page can show what's set.

**Architecture:** Backend persists a durable `reader_settings.json` snapshot on save and exposes a GET to read it. The wizard commit also sends display names. A new "Site & Scan Type" section on the RFID Settings page loads the active reader + active move + scan types, pre-fills from the snapshot, and saves via the same `POST /local/setup/reader-settings`.

**Tech Stack:** Python 3.13 / FastAPI / pytest (API); Next 16 / React 19 / TypeScript (portal).

## Global Constraints

- Site/scan persistence is a durable file `/var/lib/stackpi/reader_settings.json`, written with the atomic tmpfile→fsync→`os.replace` pattern and mode 0640 (mirroring `active_selection.json` in `api/app/local.py`).
- Saving reuses `POST /local/setup/reader-settings` (cloud PATCH unchanged: still `reader_name`, `site_id`, `scan_type_id`); local persistence is additive and best-effort (a write failure logs a warning, never fails the request).
- Snapshot shape (verbatim): `{reader_name, site_id, site_name, scan_type_id, scan_type_name}`.
- API tests import `app.setup` directly and monkeypatch the file path + `_basecamp` + `_persist_setting` (no FastAPI TestClient — avoids python-multipart).
- Portal: straight ASCII quotes for all attributes/code. Em-dash / ellipsis are fine inside JSX *text* (the config pages already use `— None —`). Run `tsc` ONCE (no concurrent runs).
- Spec: `docs/superpowers/specs/2026-06-29-config-reader-site-scan-design.md`.

---

### Task 1: Backend — persist snapshot + GET endpoint

**Files:**
- Modify: `api/app/setup.py` (imports ~line 19; `ReaderSettingsRequest` ~line 103; `set_reader_settings` ~line 114; add helpers + GET route)
- Test: `api/tests/test_reader_settings_persist.py`

**Interfaces:**
- Produces: `_read_reader_settings() -> dict`, `_write_reader_settings(dict) -> bool`, `GET /local/setup/reader-settings`; `ReaderSettingsRequest` gains `site_name`/`scan_type_name`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_reader_settings_persist.py
"""reader-settings persists a durable snapshot the config page reads back."""
from app import setup as s

EMPTY = {"reader_name": None, "site_id": None, "site_name": None,
         "scan_type_id": None, "scan_type_name": None}


def test_set_reader_settings_writes_snapshot(monkeypatch, tmp_path):
    monkeypatch.setattr(s, "_READER_SETTINGS_FILE", tmp_path / "reader_settings.json")
    monkeypatch.setattr(s, "_basecamp", lambda *a, **k: {"ok": True})
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: True)
    body = s.ReaderSettingsRequest(reader_name="FX9600647D23", site_id=5, scan_type_id=2,
                                   site_name="Dock A", scan_type_name="RFID 2")
    s.set_reader_settings(body)
    assert s.get_reader_settings() == {
        "reader_name": "FX9600647D23", "site_id": 5, "site_name": "Dock A",
        "scan_type_id": 2, "scan_type_name": "RFID 2"}


def test_get_reader_settings_empty_when_absent(monkeypatch, tmp_path):
    monkeypatch.setattr(s, "_READER_SETTINGS_FILE", tmp_path / "nope.json")
    assert s.get_reader_settings() == EMPTY


def test_set_reader_settings_blank_names_become_null(monkeypatch, tmp_path):
    monkeypatch.setattr(s, "_READER_SETTINGS_FILE", tmp_path / "reader_settings.json")
    monkeypatch.setattr(s, "_basecamp", lambda *a, **k: {"ok": True})
    monkeypatch.setattr("app.settings._persist_setting", lambda k, v: True)
    body = s.ReaderSettingsRequest(reader_name="R", site_id=1, scan_type_id=1)
    s.set_reader_settings(body)
    out = s.get_reader_settings()
    assert out["site_name"] is None and out["scan_type_name"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_settings_persist.py -q`
Expected: FAIL — `AttributeError: module 'app.setup' has no attribute '_READER_SETTINGS_FILE'` / `get_reader_settings`.

- [ ] **Step 3: Add imports**

In `api/app/setup.py`, add to the stdlib import group (with `import logging`):

```python
import json
import os
import tempfile
from pathlib import Path
```

- [ ] **Step 4: Add the durable snapshot helpers**

Add near the top of the module body (e.g. just after `_TIMEOUT = 10`):

```python
# Durable reader site/scan-type snapshot. Stored on the systemd StateDirectory
# (NOT local_app_settings, which is tmpfs and loses recent writes on a power
# cut) so the config page can show the current setting across reboots. Mirrors
# the active_selection.json pattern in app.local.
_READER_SETTINGS_FILE = Path("/var/lib/stackpi/reader_settings.json")
_EMPTY_READER_SETTINGS: Dict[str, Any] = {
    "reader_name": None, "site_id": None, "site_name": None,
    "scan_type_id": None, "scan_type_name": None,
}


def _read_reader_settings() -> Dict[str, Any]:
    """Return the persisted snapshot, or all-None if missing/unparseable."""
    try:
        with _READER_SETTINGS_FILE.open("r", encoding="utf-8") as f:
            parsed = json.load(f)
    except (OSError, ValueError):
        return dict(_EMPTY_READER_SETTINGS)
    if not isinstance(parsed, dict):
        return dict(_EMPTY_READER_SETTINGS)
    return {k: parsed.get(k) for k in _EMPTY_READER_SETTINGS}


def _write_reader_settings(payload: Dict[str, Any]) -> bool:
    """Atomically replace the snapshot file. Returns False on any IO failure."""
    try:
        _READER_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix=".reader_settings.", suffix=".tmp",
            dir=str(_READER_SETTINGS_FILE.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, _READER_SETTINGS_FILE)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        try:
            os.chmod(_READER_SETTINGS_FILE, 0o640)
        except OSError:
            pass
    except OSError as e:
        log.warning("reader_settings: write failed: %s", e)
        return False
    return True
```

- [ ] **Step 5: Extend `ReaderSettingsRequest` with optional names**

```python
class ReaderSettingsRequest(BaseModel):
    reader_name: str = Field(min_length=1, max_length=255)
    site_id: int
    scan_type_id: int
    site_name: Optional[str] = Field(default=None, max_length=255)
    scan_type_name: Optional[str] = Field(default=None, max_length=255)
```

- [ ] **Step 6: Persist the snapshot in `set_reader_settings`**

After the existing `_persist_setting(ACTIVE_READER_NAME_KEY, ...)` block (before `return result`), add:

```python
    snapshot = {
        "reader_name": body.reader_name.strip(),
        "site_id": body.site_id,
        "site_name": (body.site_name or "").strip() or None,
        "scan_type_id": body.scan_type_id,
        "scan_type_name": (body.scan_type_name or "").strip() or None,
    }
    if not _write_reader_settings(snapshot):
        log.warning("failed to persist reader settings snapshot")
```

- [ ] **Step 7: Add the GET route**

Add after `set_reader_settings`:

```python
@router.get("/reader-settings")
def get_reader_settings() -> Dict[str, Any]:
    """Return the persisted reader site/scan-type snapshot (or all-None)."""
    return _read_reader_settings()
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_reader_settings_persist.py -q`
Expected: PASS (3 passed).

- [ ] **Step 9: Commit**

```bash
git add api/app/setup.py api/tests/test_reader_settings_persist.py
git commit -m "feat(setup): persist reader site/scan snapshot + GET reader-settings"
```

---

### Task 2: Wizard commit sends display names

**Files:**
- Modify: `portal/src/components/wizard/StepSummary.tsx` (the `commit` function's fetch body, ~lines 92-100)

**Interfaces:**
- Consumes: `state.siteName`, `state.scanTypeName` (already in wizard state); the extended `POST /local/setup/reader-settings` from Task 1.

- [ ] **Step 1: Add names to the commit body**

Replace the `body: JSON.stringify({ ... })` in `commit`:

```tsx
        body: JSON.stringify({
          reader_name: state.readerName,
          site_id: state.siteId,
          scan_type_id: state.scanTypeId,
        }),
```

with:

```tsx
        body: JSON.stringify({
          reader_name: state.readerName,
          site_id: state.siteId,
          scan_type_id: state.scanTypeId,
          site_name: state.siteName,
          scan_type_name: state.scanTypeName,
        }),
```

- [ ] **Step 2: Verify the build compiles**

Run (from `portal/`, ONE run, wait 1-2 min): `node_modules/.bin/tsc --noEmit`
Expected: no errors referencing `StepSummary.tsx`.

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/wizard/StepSummary.tsx
git commit -m "feat(wizard): send site/scan display names on reader-settings commit"
```

---

### Task 3: Config → RFID → Settings "Site & Scan Type" section

**Files:**
- Create: `portal/src/components/settings/ReaderSiteScanSection.tsx`
- Modify: `portal/src/app/config/rfid/settings/page.tsx` (import + render the section, ~line 203 near `<AlertSettingsSection />`)

**Interfaces:**
- Consumes: `GET /local/setup/reader-settings` (Task 1), `GET /local/active-selection` (`{type,id,name}`), `GET /local/rfid/active-reader` (`{configured, name}`), `GET /local/setup/move-locations?move_id=` (`{source,destination}`), `GET /local/setup/scan-types` (`{scan_types:[{id,name,color}]}`), `POST /local/setup/reader-settings`.

- [ ] **Step 1: Create the section component**

```tsx
// portal/src/components/settings/ReaderSiteScanSection.tsx
"use client";

import { useEffect, useState } from "react";

type Site = { id: number; name: string | null };
type ScanType = { id: number; name: string; color?: string | null };
type Selection = { type?: string | null; id?: number | null; name?: string | null };
type Current = {
  reader_name: string | null;
  site_id: number | null;
  site_name: string | null;
  scan_type_id: number | null;
  scan_type_name: string | null;
};

export function ReaderSiteScanSection() {
  const [readerName, setReaderName] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [source, setSource] = useState<Site | null>(null);
  const [destination, setDestination] = useState<Site | null>(null);
  const [scanTypes, setScanTypes] = useState<ScanType[]>([]);
  const [siteId, setSiteId] = useState<string>("");
  const [scanTypeId, setScanTypeId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [curR, selR, arR, stR] = await Promise.all([
          fetch("/local/setup/reader-settings", { cache: "no-store" }),
          fetch("/local/active-selection", { cache: "no-store" }),
          fetch("/local/rfid/active-reader", { cache: "no-store" }),
          fetch("/local/setup/scan-types", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        const cur = (await curR.json().catch(() => null)) as Current | null;
        const sel = (await selR.json().catch(() => null)) as Selection | null;
        const ar = (await arR.json().catch(() => null)) as { configured?: boolean; name?: string } | null;
        const st = (await stR.json().catch(() => null)) as { scan_types?: ScanType[] } | null;
        setSelection(sel);
        setReaderName(cur?.reader_name ?? (ar?.configured ? ar?.name ?? null : null));
        setScanTypes(st?.scan_types ?? []);
        if (sel?.type === "move" && sel.id != null) {
          const locR = await fetch(`/local/setup/move-locations?move_id=${sel.id}`, { cache: "no-store" });
          const loc = (await locR.json().catch(() => null)) as { source?: Site | null; destination?: Site | null } | null;
          if (!cancelled) {
            setSource(loc?.source ?? null);
            setDestination(loc?.destination ?? null);
          }
        }
        if (cur?.site_id != null) setSiteId(String(cur.site_id));
        if (cur?.scan_type_id != null) setScanTypeId(String(cur.scan_type_id));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sites = [source, destination].filter((s): s is Site => s != null);
  const hasMove = selection?.type === "move" && selection.id != null;
  const siteValid = siteId === "" || sites.some((s) => String(s.id) === siteId);

  async function save() {
    if (!readerName) return;
    const site = sites.find((s) => String(s.id) === siteId) ?? null;
    const st = scanTypes.find((s) => String(s.id) === scanTypeId) ?? null;
    if (site == null || st == null) {
      setBanner({ kind: "error", text: "Pick a site and a scan type." });
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch("/local/setup/reader-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reader_name: readerName,
          site_id: site.id,
          site_name: site.name ?? null,
          scan_type_id: st.id,
          scan_type_name: st.name,
        }),
      });
      if (res.ok) {
        setBanner({ kind: "success", text: "Saved." });
      } else {
        const b = (await res.json().catch(() => null)) as { detail?: string } | null;
        setBanner({ kind: "error", text: b?.detail ?? "Save failed." });
      }
    } catch {
      setBanner({ kind: "error", text: "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold">Site &amp; Scan Type</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Bind the active reader to a move site and scan type without re-running setup.
      </p>
      {banner && (
        <div
          className={
            "mt-3 rounded-md px-3 py-2 text-sm " +
            (banner.kind === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700")
          }
        >
          {banner.text}
        </div>
      )}
      {!readerName ? (
        <p className="mt-4 text-sm text-amber-700">Add and select a reader first.</p>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-zinc-600">
            Reader: <span className="font-medium">{readerName}</span>
          </p>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Site (source / destination)
            </label>
            {hasMove ? (
              <select
                value={siteValid ? siteId : ""}
                onChange={(e) => setSiteId(e.target.value)}
                disabled={loading}
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">— Select —</option>
                {source && <option value={String(source.id)}>Source — {source.name ?? source.id}</option>}
                {destination && (
                  <option value={String(destination.id)}>Destination — {destination.name ?? destination.id}</option>
                )}
              </select>
            ) : (
              <p className="mt-1 text-sm text-amber-700">Select a move on the Config home page first.</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Scan type
            </label>
            <select
              value={scanTypeId}
              onChange={(e) => setScanTypeId(e.target.value)}
              disabled={loading}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="">— Select —</option>
              {scanTypes
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
                .map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={save}
              disabled={saving || loading}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:bg-zinc-400"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Render the section on the settings page**

In `portal/src/app/config/rfid/settings/page.tsx`, add the import near the top (with the `AlertSettingsSection` import):

```tsx
import { ReaderSiteScanSection } from "@/components/settings/ReaderSiteScanSection";
```

and render it just before `<AlertSettingsSection />`:

```tsx
      <ReaderSiteScanSection />
      <AlertSettingsSection />
```

- [ ] **Step 3: Verify the build compiles**

Run (from `portal/`, ONE run): `node_modules/.bin/tsc --noEmit`
Expected: no errors referencing `ReaderSiteScanSection.tsx` or `settings/page.tsx`.

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/settings/ReaderSiteScanSection.tsx portal/src/app/config/rfid/settings/page.tsx
git commit -m "feat(config): set reader site + scan type from RFID Settings page"
```

---

## Self-Review notes

- **Spec coverage:** §1 durable file + extended request + persist + GET (Task 1) ✓; §2 config section with active-reader/active-move/scan-types, pre-fill, reuse POST (Task 3) ✓; §2a wizard sends names (Task 2) ✓; §3 guard rails — no reader / not-a-move / stale site (Task 3 `!readerName`, `hasMove`, `siteValid`) ✓.
- **Type consistency:** snapshot keys `{reader_name, site_id, site_name, scan_type_id, scan_type_name}` match the `Current` TS type and the POST body; `ReaderSettingsRequest` fields match what both the wizard and the config section send.
- **Env caveat:** API tests import `app.setup` directly and monkeypatch the path/_basecamp/_persist_setting (no TestClient). Portal gate is `tsc` (single run).
- **Live verification (Pi):** save from the config page, confirm the cloud reflects it and the page re-shows the values after reload (and after a reboot, given the durable file).
