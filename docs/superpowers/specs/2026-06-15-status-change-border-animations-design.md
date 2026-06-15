# Status Screen — Selectable Change-Border Animations

**Date:** 2026-06-15
**Status:** Approved (design)

## Problem / Goal

The `/status` kiosk page flashes a border animation on each metric card when its
value changes (or when fired from the settings "Test" button). Today this is a
single hard-coded effect: a flat colored quarter-segment that slides clockwise
once per cycle, implemented in pure CSS (`@keyframes chase-stroke`) via an SVG
`<rect>` `stroke-dashoffset` animation.

We want richer, more legible "this card just changed" feedback, and we want the
operator to choose between several looks — the same way they already choose
color, width, and cycle count.

## Outcome

- The flat CSS chase is **removed**.
- Three GSAP-driven animation styles are added: **Comet**, **Pulse**, **Dual**.
- A new **Style** dropdown on `/config/settings/screen-status` selects the active
  style, persisted like the other change-animation settings.
- Default style is **Comet** (closest in feel to the chase being removed).

Animation styles (validated visually in the brainstorming companion):

- **Comet** — a bright glowing head with a soft trailing tail eases around the
  card perimeter, one loop per cycle. Smooth, single moving accent.
- **Pulse** — the entire border ignites and pulses (bright → dim) `cycleCount`
  times, then fades out. No travel; reads as "changed" from across a room.
- **Dual** — two glowing segments chase from opposite corners and meet,
  `cycleCount` loops. Most energetic.

## Non-Goals

- No three.js / WebGL. These are 2D perimeter effects; WebGL would be wasted
  weight on the Raspberry Pi kiosk.
- No change to *what* triggers the animation (value change + Test force-fire),
  to the auto-clear, traffic-light, or activity-feed behavior.
- No new per-style configuration knobs beyond the existing color / width /
  cycle-count (which all three styles reuse).

## Design

### Layer 1 — Backend setting (`api/app/settings.py`)

Settings are key/value rows in `local_app_settings`; absent keys fall back to a
default. **No DB migration is required.**

- New constants:
  - `_SCREEN_STATUS_KEY_BORDER_STYLE = "screen_status_change_border_style"`
  - `_SCREEN_STATUS_DEFAULT_BORDER_STYLE = "comet"`
  - `_SCREEN_STATUS_BORDER_STYLE_OPTIONS = ("comet", "pulse", "dual")`
- `_get_screen_status_payload()` adds three fields, mirroring how color exposes
  its default:
  - `change_border_style` (current value via `_get_setting_str`, coerced to a
    valid option — fall back to default if the stored value is unknown)
  - `change_border_style_default`
  - `change_border_style_options` (the tuple, so the UI builds the dropdown from
    the server's source of truth)
- `ScreenStatusRequest` gains `change_border_style: Optional[str] = None`,
  validated against `_SCREEN_STATUS_BORDER_STYLE_OPTIONS`. An unknown value
  raises `HTTPException(400, detail="change_border_style must be one of: comet, pulse, dual")`,
  same shape as the existing color-format error.
- The POST handler persists it via the existing `_persist_setting` when present.

### Layer 2 — Animation component (`portal/src/components/`)

- Add **`gsap`** to `portal/package.json` (bundled by Next.js / npm — no CDN, so
  the offline kiosk works; loaded once per kiosk session). The lockfile is
  updated locally with `npm install gsap --package-lock-only` (writes
  `package-lock.json` only — **no `node_modules`**, so the local working tree
  stays clean) to keep the Pi's `npm ci` reproducible.
- Replace `ChaseBorder.tsx` with **`ChangeBorder.tsx`**, exporting:
  - `type ChangeBorderStyle = "comet" | "pulse" | "dual"`
  - `CHANGE_BORDER_STYLES` — a registry keyed by style, each entry providing a
    human label, a `perCycleMs` duration, and a GSAP timeline builder.
  - `<ChangeBorder style color widthPx cornerRadiusPx cycleCount />`.
- The component renders the SVG scaffold (same sizing math as today: SVG inset by
  half the stroke width, `pathLength=100`, `non-scaling-stroke`,
  `overflow: visible`) and drives it with a GSAP timeline inside a
  `useLayoutEffect` wrapped in `gsap.context()`, which kills the tween on unmount.
- The existing **mount → key-on-bump → unmount-after-timeout** lifecycle in
  `MetricCard` and `PreviewBox` is unchanged. The only change there: the
  auto-hide timeout becomes `CHANGE_BORDER_STYLES[style].perCycleMs * cycleCount
  + buffer` instead of the single hard-coded `CHASE_DURATION_PER_CYCLE_MS`.
- Builders reuse the validated companion prototypes:
  - Comet: eased (`power1.inOut`) head+trail dash with an SVG Gaussian-blur glow,
    one perimeter loop per cycle, brief fade-out at the end.
  - Pulse: full-perimeter stroke, opacity ignites→dims `cycleCount` times then
    fades.
  - Dual: two glowing dash segments offset 50% on the normalized perimeter, each
    looping `cycleCount` times.
- Delete the `@keyframes chase-stroke` block from `portal/src/app/globals.css`.

### Layer 3 — Status page (`portal/src/app/status/page.tsx`)

- Read `change_border_style` in the existing screen-status poll; store as state
  (default `"comet"`). Validate to a known style on read.
- Thread it into all 8 `MetricCard`s as a `style` prop; `MetricCard` forwards it
  to `ChangeBorder`. The Test force-fire sequence (`runChaseSequence`,
  `cardForceFire`) is unchanged.

### Layer 4 — Settings page (`portal/src/app/config/settings/screen-status/page.tsx`)

- Extend `ScreenStatusSettings` type with the three new fields.
- Add a **Style** `<select>` to the "Change Animation" section, options built
  from `change_border_style_options`. Track it in form state; include in the
  save body, the `load()` hydration, and the `dirty` comparison.
- The 8-box live preview renders the **currently-selected** (form, not persisted)
  style via `ChangeBorder`, so Test previews the chosen effect before saving.
- The cycle-count field label adapts: "revolutions" for Comet/Dual, "**pulses**"
  for Pulse. Min/max (1–10) unchanged.

## Testing & verification

**No builds run on the local dev machine.** `next build`/`dev` and `npm install`
generate tens of thousands of files in the working tree, which has caused
file-count errors locally. All building, the test suite, and visual verification
happen **on the Pi** (which is the build host the deploy script already targets).
Locally we only edit source and update `package-lock.json` (lockfile-only, no
`node_modules`).

- **pytest** (`api/tests/`, run on the Pi via the api `.venv`):
  `change_border_style` validation in `ScreenStatusRequest` / the POST endpoint —
  a valid value persists and is returned by the payload; an unknown value returns
  400; an omitted field leaves the prior value intact; the payload exposes
  `_default` and `_options`.
- **Build**: `npm ci && npm run build` for the portal, on the Pi (via
  `deploy/deploy.sh`). A clean build is the type-check / compile gate.
- **Visual**: the settings-page **Test** button (live preview of each style) and
  the `/status` kiosk, observed on the Pi at 10.10.48.167.
- TDD applies where logic is testable (backend validation; the style-registry
  duration math). The GSAP rendering is verified by observation on the Pi.

## Implementation Constraints

- Per `portal/AGENTS.md`: this Next.js has breaking changes from common
  knowledge — consult `node_modules/next/dist/docs/` before writing portal code.
- Keep component units small and focused (the style registry + builders are the
  natural seam).

## Deployment & Pi verification flow

The Pi is both the verification host and the deploy target (user-authorized for
this work). The mechanism is the existing **`scripts/test_deploy.sh`**, which
reads `scripts/.env.test_deploy` (Pi at `csg@10.10.48.167`, repo path
`/home/csg/StackPI_v2`), rsyncs the **local working tree** to the Pi — excluding
`node_modules/`, `.next/`, `.git/`, `.venv/`, etc. — then runs `install.sh` +
`deploy.sh` on the Pi with `SKIP_GIT_PULL=1`. The portal `npm ci && npm run
build` therefore runs **only on the Pi**; nothing builds locally and no branch
push is required for verification. Prereqs `sshpass` + `rsync` are present on the
dev Mac.

Flow:

1. Implement locally (source edits only) + `npm install gsap --package-lock-only`
   (lockfile-only; no `node_modules`).
2. `bash scripts/test_deploy.sh` — rsync to the Pi and build/restart there.
3. Run the backend tests on the Pi (`api/.venv/bin/pytest`).
4. Verify visually on the kiosk (`/status` + the screen-status settings **Test**
   button) at 10.10.48.167.
5. Commit the branch; once the operator is happy, merge to `main`.

Note: `test_deploy.sh` → `deploy.sh` is a *full* deploy (restarts api, engine,
portal, pgweb; reapplies SQL; reinstalls kiosk/plymouth/sudoers assets). That is
acceptable here and is the project's established test-deploy path.
