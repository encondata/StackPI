# Status Change-Border Animations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single CSS chase animation on `/status` metric cards with three GSAP-driven styles — Comet, Pulse, Dual — selectable via a new "Style" dropdown on the screen-status settings page.

**Architecture:** A new enum setting `change_border_style` threads through the existing key/value settings backend → the `/status` poll → a new style-aware `ChangeBorder` component. The flat CSS chase is removed. All building and verification happen on the Pi via `scripts/test_deploy.sh`; nothing builds on the local Mac.

**Tech Stack:** FastAPI + Pydantic (Python), Next.js 16 / React 19 (TypeScript), GSAP 3, Tailwind. Postgres key/value settings table `local_app_settings`.

---

## Important constraints

- **No local builds.** Do NOT run `npm install` (except the lockfile-only step below), `npm run build`, or `npm run dev` on the dev Mac — they spray tens of thousands of files into the tree and have caused file-count errors. The Pi is the build/verify host.
- Per `portal/AGENTS.md`: this Next.js has breaking changes from common knowledge. Before editing portal files, skim the relevant guide under `portal/node_modules/next/dist/docs/` **on the Pi** (or trust the existing patterns in the files you're editing — they already compile under this version).
- Default style is **`comet`**. Pulse reuses the cycle-count field as "number of pulses."

## File Structure

- **Modify** `api/app/settings.py` — add the `change_border_style` constants, payload fields, request field, validation, and persistence.
- **Create** `api/tests/test_screen_status_settings.py` — backend validation tests.
- **Modify** `portal/package.json` + `portal/package-lock.json` — add `gsap` (lockfile-only locally).
- **Create** `portal/src/components/ChangeBorder.tsx` — style registry + the three GSAP border components.
- **Delete** `portal/src/components/ChaseBorder.tsx` — replaced by `ChangeBorder.tsx`.
- **Modify** `portal/src/app/globals.css` — remove the now-unused `@keyframes chase-stroke` block.
- **Modify** `portal/src/app/status/page.tsx` — read `change_border_style`, thread it into `MetricCard` → `ChangeBorder`.
- **Modify** `portal/src/app/config/settings/screen-status/page.tsx` — Style dropdown, save/load/dirty, adaptive cycle label, preview uses `ChangeBorder`.

---

### Task 1: Backend — add `change_border_style` setting

**Files:**
- Modify: `api/app/settings.py`
- Test: `api/tests/test_screen_status_settings.py`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_screen_status_settings.py`:

```python
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

PATH = "/local/settings/screen-status"


def test_payload_exposes_style_default_and_options() -> None:
    r = client.get(PATH)
    assert r.status_code == 200
    body = r.json()
    assert body["change_border_style_default"] == "comet"
    assert body["change_border_style_options"] == ["comet", "pulse", "dual"]
    # Current value is always one of the allowed options.
    assert body["change_border_style"] in body["change_border_style_options"]


def test_unknown_style_is_rejected() -> None:
    r = client.post(PATH, json={"change_border_style": "sparkle"})
    assert r.status_code == 400
    assert "change_border_style" in r.json()["detail"]


def test_omitted_style_is_accepted() -> None:
    # Posting an unrelated field must not require change_border_style.
    r = client.post(PATH, json={"change_border_cycle_count": 2})
    assert r.status_code == 200
    assert "change_border_style" in r.json()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (on the Pi, after a sync — see Task 6 — or any host with the api venv + Postgres):
`cd api && .venv/bin/pytest tests/test_screen_status_settings.py -v`
Expected: FAIL — `change_border_style_default` / options keys missing from payload; unknown style currently returns 200.

- [ ] **Step 3: Add the constants**

In `api/app/settings.py`, after the `_SCREEN_STATUS_KEY_CHASE_TEST` definition (around line 394), add:

```python
_SCREEN_STATUS_KEY_BORDER_STYLE  = "screen_status_change_border_style"
```

And after the cycle-count constants block (after `_SCREEN_STATUS_MAX_CYCLE_COUNT = 10`, around line 408), add:

```python
_SCREEN_STATUS_DEFAULT_BORDER_STYLE = "comet"
_SCREEN_STATUS_BORDER_STYLE_OPTIONS = ("comet", "pulse", "dual")
```

- [ ] **Step 4: Add the request field**

In `api/app/settings.py`, in `class ScreenStatusRequest` (around line 420), add after `change_border_cycle_count`:

```python
    change_border_style: Optional[str] = Field(default=None, max_length=16)
```

- [ ] **Step 5: Expose the fields in the payload**

In `_get_screen_status_payload()` (around line 476), add these entries to the returned dict, just before the `"chase_test_triggered_at"` entry:

```python
        "change_border_style": (
            _get_setting_str(
                _SCREEN_STATUS_KEY_BORDER_STYLE,
                _SCREEN_STATUS_DEFAULT_BORDER_STYLE,
            )
            if _get_setting_str(
                _SCREEN_STATUS_KEY_BORDER_STYLE,
                _SCREEN_STATUS_DEFAULT_BORDER_STYLE,
            )
            in _SCREEN_STATUS_BORDER_STYLE_OPTIONS
            else _SCREEN_STATUS_DEFAULT_BORDER_STYLE
        ),
        "change_border_style_default": _SCREEN_STATUS_DEFAULT_BORDER_STYLE,
        "change_border_style_options": list(_SCREEN_STATUS_BORDER_STYLE_OPTIONS),
```

- [ ] **Step 6: Validate + persist in the POST handler**

In `set_screen_status_settings()` (around line 539), add before the final `return _get_screen_status_payload()`:

```python
    if body.change_border_style is not None:
        candidate = body.change_border_style.strip().lower()
        if candidate not in _SCREEN_STATUS_BORDER_STYLE_OPTIONS:
            raise HTTPException(
                status_code=400,
                detail="change_border_style must be one of: "
                + ", ".join(_SCREEN_STATUS_BORDER_STYLE_OPTIONS),
            )
        if not _persist_setting(_SCREEN_STATUS_KEY_BORDER_STYLE, candidate):
            raise HTTPException(
                status_code=500, detail="failed to persist change_border_style"
            )
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd api && .venv/bin/pytest tests/test_screen_status_settings.py -v`
Expected: PASS (3 passed).

- [ ] **Step 8: Commit**

```bash
git add api/app/settings.py api/tests/test_screen_status_settings.py
git commit -m "feat(api): add change_border_style screen-status setting"
```

---

### Task 2: Add gsap + create the `ChangeBorder` component

**Files:**
- Modify: `portal/package.json`, `portal/package-lock.json`
- Create: `portal/src/components/ChangeBorder.tsx`
- Delete: `portal/src/components/ChaseBorder.tsx`
- Modify: `portal/src/app/globals.css`

- [ ] **Step 1: Add gsap to the lockfile (no node_modules)**

Run from the repo root on the Mac:
`cd portal && npm install gsap@^3.12.5 --package-lock-only`
Expected: `package.json` gains `"gsap": "^3.12.5"` under dependencies and `package-lock.json` updates. **Verify no `node_modules/` directory was created:** `ls portal | grep node_modules` should print nothing.

- [ ] **Step 2: Create `portal/src/components/ChangeBorder.tsx`**

```tsx
"use client";

import { useId, useLayoutEffect, useRef } from "react";
import gsap from "gsap";

/**
 * Change-border animations for /status metric cards. One of three styles
 * fires on a card change (the parent keys/remounts the component per fire
 * and unmounts it after changeBorderDurationMs(...) elapses).
 *
 * Shared SVG sizing math (same as the old ChaseBorder): the SVG is inset by
 * half the stroke width on every side so the stroke's outer edge lands on
 * the card edge; pathLength=100 normalizes the perimeter so dash values are
 * percentage-like; non-scaling-stroke keeps the visible width constant;
 * overflow:visible keeps the outer half of the stroke painted.
 */

export const CHANGE_BORDER_STYLES = {
  comet: { label: "Comet", perCycleMs: 1600 },
  pulse: { label: "Pulse", perCycleMs: 600 },
  dual: { label: "Dual", perCycleMs: 1500 },
} as const;

export type ChangeBorderStyle = keyof typeof CHANGE_BORDER_STYLES;

export const CHANGE_BORDER_STYLE_LIST = Object.keys(
  CHANGE_BORDER_STYLES,
) as ChangeBorderStyle[];

/** Narrow an arbitrary string to a known style, falling back to comet. */
export function toChangeBorderStyle(s: string | undefined | null): ChangeBorderStyle {
  return s != null && s in CHANGE_BORDER_STYLES
    ? (s as ChangeBorderStyle)
    : "comet";
}

/** Total on-screen time for one fire (one revolution/pulse per cycle). The
 *  parent uses this to schedule unmount; add a small buffer on top. */
export function changeBorderDurationMs(
  style: ChangeBorderStyle,
  cycleCount: number,
): number {
  return CHANGE_BORDER_STYLES[style].perCycleMs * Math.max(1, cycleCount);
}

type StyleProps = {
  color: string;
  widthPx: number;
  cornerRadiusPx: number;
  cycleCount: number;
};

export function ChangeBorder({
  style,
  ...rest
}: StyleProps & { style: ChangeBorderStyle }) {
  if (style === "pulse") return <PulseBorder {...rest} />;
  if (style === "dual") return <DualBorder {...rest} />;
  return <CometBorder {...rest} />;
}

// useId() returns ids containing ":" which are invalid in SVG/CSS url(#…)
// references, so strip them.
function useGlowId(): string {
  return "cb-glow-" + useId().replace(/:/g, "");
}

function BorderSvg({
  widthPx,
  glowId,
  children,
}: {
  widthPx: number;
  glowId: string;
  children: React.ReactNode;
}) {
  const half = widthPx / 2;
  return (
    <svg
      className="pointer-events-none absolute"
      style={{
        top: half,
        left: half,
        width: `calc(100% - ${widthPx}px)`,
        height: `calc(100% - ${widthPx}px)`,
        overflow: "visible",
      }}
      aria-hidden
    >
      <defs>
        <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={Math.max(1.5, half * 0.6)} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {children}
    </svg>
  );
}

function rectProps(color: string, widthPx: number, cornerRadiusPx: number) {
  const half = widthPx / 2;
  return {
    x: 0,
    y: 0,
    width: "100%",
    height: "100%",
    rx: Math.max(0, cornerRadiusPx - half),
    ry: Math.max(0, cornerRadiusPx - half),
    fill: "none",
    stroke: color,
    strokeWidth: widthPx,
    pathLength: 100,
    strokeLinecap: "round" as const,
    vectorEffect: "non-scaling-stroke" as const,
  };
}

// Comet: a single glowing head+trail dash travels the perimeter, one full
// revolution per cycle, at constant speed.
function CometBorder({ color, widthPx, cornerRadiusPx, cycleCount }: StyleProps) {
  const glowId = useGlowId();
  const ref = useRef<SVGRectElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cycles = Math.max(1, cycleCount);
    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { attr: { "stroke-dashoffset": 0 } },
        {
          attr: { "stroke-dashoffset": -100 * cycles },
          duration: changeBorderDurationMs("comet", cycleCount) / 1000,
          ease: "none",
        },
      );
    });
    return () => ctx.revert();
  }, [cycleCount]);
  return (
    <BorderSvg widthPx={widthPx} glowId={glowId}>
      <rect
        ref={ref}
        {...rectProps(color, widthPx, cornerRadiusPx)}
        strokeDasharray="18 82"
        filter={`url(#${glowId})`}
      />
    </BorderSvg>
  );
}

// Dual: two glowing segments offset half a perimeter apart chase together.
function DualBorder({ color, widthPx, cornerRadiusPx, cycleCount }: StyleProps) {
  const glowId = useGlowId();
  const aRef = useRef<SVGRectElement>(null);
  const bRef = useRef<SVGRectElement>(null);
  useLayoutEffect(() => {
    const cycles = Math.max(1, cycleCount);
    const dur = changeBorderDurationMs("dual", cycleCount) / 1000;
    const ctx = gsap.context(() => {
      [
        { el: aRef.current, start: 0 },
        { el: bRef.current, start: 50 },
      ].forEach(({ el, start }) => {
        if (!el) return;
        gsap.fromTo(
          el,
          { attr: { "stroke-dashoffset": -start } },
          {
            attr: { "stroke-dashoffset": -(start + 100 * cycles) },
            duration: dur,
            ease: "none",
          },
        );
      });
    });
    return () => ctx.revert();
  }, [cycleCount]);
  const rp = rectProps(color, widthPx, cornerRadiusPx);
  return (
    <BorderSvg widthPx={widthPx} glowId={glowId}>
      <rect ref={aRef} {...rp} strokeDasharray="14 86" filter={`url(#${glowId})`} />
      <rect ref={bRef} {...rp} strokeDasharray="14 86" filter={`url(#${glowId})`} />
    </BorderSvg>
  );
}

// Pulse: the whole perimeter ignites and dims `cycleCount` times, then fades.
function PulseBorder({ color, widthPx, cornerRadiusPx, cycleCount }: StyleProps) {
  const glowId = useGlowId();
  const ref = useRef<SVGRectElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cycles = Math.max(1, cycleCount);
    const per = CHANGE_BORDER_STYLES.pulse.perCycleMs / 1000;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline();
      tl.set(el, { opacity: 0 });
      for (let i = 0; i < cycles; i++) {
        tl.to(el, { opacity: 1, duration: per * 0.3, ease: "power2.out" }).to(
          el,
          { opacity: 0.2, duration: per * 0.7, ease: "sine.inOut" },
        );
      }
      tl.to(el, { opacity: 0, duration: 0.2, ease: "power2.in" });
    });
    return () => ctx.revert();
  }, [cycleCount]);
  return (
    <BorderSvg widthPx={widthPx} glowId={glowId}>
      <rect
        ref={ref}
        {...rectProps(color, widthPx, cornerRadiusPx)}
        filter={`url(#${glowId})`}
      />
    </BorderSvg>
  );
}
```

- [ ] **Step 3: Delete the old component**

Run: `git rm portal/src/components/ChaseBorder.tsx`

- [ ] **Step 4: Remove the unused keyframes**

In `portal/src/app/globals.css`, delete the entire `@keyframes chase-stroke { … }` block (around line 43) and the explanatory comment block immediately above it that describes the chase-stroke animation (the comment starting with the SVG `<rect>` / `stroke-dashoffset` description, lines ~30–46).

- [ ] **Step 5: Commit**

```bash
git add portal/package.json portal/package-lock.json portal/src/components/ChangeBorder.tsx portal/src/app/globals.css
git commit -m "feat(portal): add GSAP ChangeBorder component, drop CSS chase"
```

(The build that validates this compiles runs on the Pi in Task 6.)

---

### Task 3: Wire `status/page.tsx` to the new component

**Files:**
- Modify: `portal/src/app/status/page.tsx`

- [ ] **Step 1: Swap the import**

Replace line 5:

```tsx
import { ChaseBorder } from "@/components/ChaseBorder";
```

with:

```tsx
import {
  ChangeBorder,
  changeBorderDurationMs,
  toChangeBorderStyle,
  type ChangeBorderStyle,
} from "@/components/ChangeBorder";
```

- [ ] **Step 2: Add style state**

After the `changeBorderCycleCount` state (around line 333-334), add:

```tsx
  const [changeBorderStyle, setChangeBorderStyle] =
    useState<ChangeBorderStyle>("comet");
```

- [ ] **Step 3: Read the style from the settings poll**

In the screen-status poll effect, in the response type (around line 479) add `change_border_style?: string;` to the destructured shape, and after the `change_border_cycle_count` handling (around line 496) add:

```tsx
          if (typeof d.change_border_style === "string") {
            setChangeBorderStyle(toChangeBorderStyle(d.change_border_style));
          }
```

- [ ] **Step 4: Pass `chaseStyle` into every MetricCard**

For each of the 8 `<MetricCard … />` instances (lines ~863-919), add the prop `chaseStyle={changeBorderStyle}` alongside the existing `chaseColor`/`chaseWidthPx`/`chaseCycleCount` props. Example for the first card:

```tsx
        <MetricCard label="Tags Today"   value={metric(metrics.tags_today)}   chaseStyle={changeBorderStyle} chaseColor={changeBorderColor} chaseWidthPx={changeBorderWidthPx} chaseCycleCount={changeBorderCycleCount} forceFire={cardForceFire[0]} />
```

- [ ] **Step 5: Update the MetricCard component**

Replace the `CHASE_DURATION_PER_CYCLE_MS` constant (around line 958) — delete that line.

In `MetricCard`'s props type (around line 960-981), add `chaseStyle: ChangeBorderStyle;` to the destructure and the type.

Add a style ref next to `chaseCycleCountRef` (around line 993):

```tsx
  const chaseStyleRef = useRef<ChangeBorderStyle>(chaseStyle);
  useEffect(() => {
    chaseStyleRef.current = chaseStyle;
  }, [chaseStyle]);
```

In `fireChase()` (around line 998-1008), replace the timeout duration calc:

```tsx
  function fireChase() {
    if (chaseHideTimerRef.current !== null) {
      window.clearTimeout(chaseHideTimerRef.current);
    }
    const cycles = Math.max(1, chaseCycleCountRef.current);
    setChaseBump((prev) => (prev ?? 0) + 1);
    chaseHideTimerRef.current = window.setTimeout(() => {
      setChaseBump(null);
      chaseHideTimerRef.current = null;
    }, changeBorderDurationMs(chaseStyleRef.current, cycles) + 250);
  }
```

Replace the `<ChaseBorder … />` render (around line 1038-1047) with:

```tsx
      {chaseBump !== null && (
        <ChangeBorder
          key={chaseBump}
          style={chaseStyle}
          color={chaseColor}
          widthPx={chaseWidthPx}
          cornerRadiusPx={16}
          cycleCount={Math.max(1, chaseCycleCount)}
        />
      )}
```

- [ ] **Step 6: Commit**

```bash
git add portal/src/app/status/page.tsx
git commit -m "feat(portal): render selected change-border style on /status"
```

---

### Task 4: Settings page — Style dropdown, preview, adaptive label

**Files:**
- Modify: `portal/src/app/config/settings/screen-status/page.tsx`

- [ ] **Step 1: Swap the import**

Replace line 4:

```tsx
import { ChaseBorder } from "@/components/ChaseBorder";
```

with:

```tsx
import {
  ChangeBorder,
  changeBorderDurationMs,
  toChangeBorderStyle,
  type ChangeBorderStyle,
} from "@/components/ChangeBorder";
```

- [ ] **Step 2: Extend the settings type**

In `type ScreenStatusSettings` (around line 6-24), add:

```tsx
  change_border_style: string;
  change_border_style_default: string;
  change_border_style_options: string[];
```

- [ ] **Step 3: Add form state + hydrate it**

After the `cycleCountInput` state (around line 134), add:

```tsx
  const [borderStyleInput, setBorderStyleInput] =
    useState<ChangeBorderStyle>("comet");
```

In `load()` (around line 158-164), after `setCycleCountInput(...)`, add:

```tsx
          setBorderStyleInput(toChangeBorderStyle(body.change_border_style));
```

- [ ] **Step 4: Include style in save, response re-hydrate, and dirty check**

In `save()`'s POST body (around line 223-228), add `change_border_style: borderStyleInput,`.

In the success branch where state is re-set from the response (around line 233-237), add:

```tsx
        setBorderStyleInput(toChangeBorderStyle(updated.change_border_style));
```

In the `dirty` computation (around line 304-309), add this clause inside the `||` chain:

```tsx
      data.change_border_style !== borderStyleInput ||
```

- [ ] **Step 5: Add the Style dropdown to the form**

In the Change Animation section's grid (`<div className="mt-5 grid gap-5 sm:grid-cols-3">`, around line 382), the grid currently holds 3 children (width, cycles, color). Change it to a 4-up grid and add the Style select as the first child. Change the wrapper to:

```tsx
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
```

Then insert, as the first child of that grid (before the Border width label):

```tsx
          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Style
            </span>
            <div className="mt-1">
              <select
                value={borderStyleInput}
                disabled={busy || !data}
                onChange={(e) =>
                  setBorderStyleInput(toChangeBorderStyle(e.target.value))
                }
                className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm capitalize disabled:opacity-60"
              >
                {(data?.change_border_style_options ?? ["comet", "pulse", "dual"]).map(
                  (opt) => (
                    <option key={opt} value={opt} className="capitalize">
                      {opt}
                    </option>
                  ),
                )}
              </select>
            </div>
            {data && (
              <p className="mt-2 text-xs text-zinc-500">
                Default:{" "}
                <span className="font-mono capitalize">
                  {data.change_border_style_default}
                </span>
                .
              </p>
            )}
          </label>
```

- [ ] **Step 6: Make the cycle-count unit label adapt**

In the Cycle count label, replace the unit `<span>` (currently `<span className="text-sm text-zinc-600">revolutions</span>`, around line 436) with:

```tsx
              <span className="text-sm text-zinc-600">
                {borderStyleInput === "pulse" ? "pulses" : "revolutions"}
              </span>
```

- [ ] **Step 7: Pass the style into the preview boxes**

Where the preview boxes are rendered (around line 511-521), add `chaseStyle={borderStyleInput}` to each `<PreviewBox … />`:

```tsx
            <PreviewBox
              key={i}
              index={i}
              bump={previewBumps[i] ?? 0}
              chaseStyle={borderStyleInput}
              chaseColor={borderColor || "#22c55e"}
              chaseWidthPx={previewWidthSafe}
              chaseCycleCount={previewCycleCount}
            />
```

- [ ] **Step 8: Update PreviewBox to use ChangeBorder**

Delete the `PREVIEW_CHASE_PER_CYCLE_MS` constant (around line 692).

In `PreviewBox`'s props (around line 694-705), add `chaseStyle: ChangeBorderStyle;` to the type and destructure.

In the hide-timer effect (around line 718-731), replace the timeout duration:

```tsx
      setVisibleBump(bump);
      const cycles = Math.max(1, cyclesRef.current);
      hideTimerRef.current = window.setTimeout(() => {
        setVisibleBump(null);
        hideTimerRef.current = null;
      }, changeBorderDurationMs(chaseStyle, cycles) + 250);
```

Replace the `<ChaseBorder … />` render (around line 743-752) with:

```tsx
      {visibleBump !== null && (
        <ChangeBorder
          key={visibleBump}
          style={chaseStyle}
          color={chaseColor}
          widthPx={chaseWidthPx}
          cornerRadiusPx={12}
          cycleCount={Math.max(1, chaseCycleCount)}
        />
      )}
```

- [ ] **Step 9: Commit**

```bash
git add portal/src/app/config/settings/screen-status/page.tsx
git commit -m "feat(portal): add change-border Style dropdown + preview"
```

---

### Task 5: Self-check the wiring (local, no build)

**Files:** none (read-only verification)

- [ ] **Step 1: Confirm no stray references to the old component**

Run: `grep -rn "ChaseBorder\|chase-stroke\|CHASE_DURATION\|PREVIEW_CHASE_PER_CYCLE_MS" portal/src`
Expected: no matches (all replaced).

- [ ] **Step 2: Confirm the new prop is on all cards**

Run: `grep -c "chaseStyle=" portal/src/app/status/page.tsx`
Expected: `8` (one per MetricCard).

- [ ] **Step 3: Confirm gsap is declared but not installed locally**

Run: `grep gsap portal/package.json && ls portal | grep -c node_modules`
Expected: the gsap line prints; the count is `0`.

---

### Task 6: Build + verify on the Pi

**Files:** none (deploy + observe)

- [ ] **Step 1: Push the working tree to the Pi and build there**

Run from the repo root: `bash scripts/test_deploy.sh`
Expected: rsync completes, then `npm ci && npm run build` runs **on the Pi** and succeeds (this is the TypeScript/compile gate), services restart, and the script prints `Test deploy finished — 10.10.48.167`.
If the portal build fails, read the error, fix the source locally, and re-run `scripts/test_deploy.sh` (do NOT build locally).

- [ ] **Step 2: Run the backend tests on the Pi**

Run: `sshpass -e ssh -o StrictHostKeyChecking=accept-new csg@10.10.48.167 'cd /home/csg/StackPI_v2/api && .venv/bin/pytest tests/test_screen_status_settings.py -v'`
(`SSHPASS` is exported by sourcing `scripts/.env.test_deploy`; or rely on test_deploy having run.)
Expected: 3 passed.

- [ ] **Step 3: Visual verification on the kiosk**

On the kiosk display (or a browser pointed at the Pi):
1. Open `/config/settings/screen-status`. Confirm the **Style** dropdown shows Comet / Pulse / Dual.
2. For each style: select it, confirm the cycle-count unit reads "pulses" for Pulse and "revolutions" otherwise, click **Test**, and confirm the 8 preview boxes animate the selected style.
3. Click **Apply**. Within ~30s the `/status` kiosk picks up the style. Trigger Test again (or wait for a real metric change) and confirm `/status` cards animate the chosen style with the configured color/width/cycles.

- [ ] **Step 4: Final commit (if any fixes were made in Step 1)**

```bash
git add -A
git commit -m "fix: address Pi build/verify findings for change-border styles"
```

---

## Self-Review notes (author)

- **Spec coverage:** backend enum (Task 1) ✓; gsap dep + ChangeBorder with Comet/Pulse/Dual + keyframe removal (Task 2) ✓; status page wiring (Task 3) ✓; settings dropdown + preview + adaptive label (Task 4) ✓; no-local-build + Pi verify + pytest (Tasks 5–6) ✓; default comet ✓; pulse-as-pulses label ✓.
- **No JS unit tests:** the portal has no test runner configured; introducing one is out of scope (YAGNI). The compile gate is `npm run build` on the Pi; animation correctness is verified visually. This is called out honestly rather than fabricating tests.
- **Type consistency:** `ChangeBorderStyle`, `changeBorderDurationMs`, `toChangeBorderStyle`, `CHANGE_BORDER_STYLES`, and the `chaseStyle` prop name are used identically across Tasks 2–4.
