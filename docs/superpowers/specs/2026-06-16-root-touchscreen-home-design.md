# Root Touchscreen Home Page

**Date:** 2026-06-16
**Status:** Approved (design)

## Problem / Goal

The root `/` page is the device kiosk screen, driven by registration state
(`/local/status`): loading logo → pairing QR/token → registered → revoked.
When the device is **registered**, it currently shows only the StackPI logo
(`LogoShell`). We want that registered state to instead present a useful
touchscreen **home** for the 800×480 panel: a small status bar plus four
config entry-point cards.

## Outcome

When `status === "registered"`, `/` renders a new home screen:

- **2×2 grid of 4 cards**, centered, filling the area above the status bar:
  **Initial Setup**, **Config**, **Internet**, **Un-Used**. Each card shows a
  relevant icon above its title. "Un-Used" is rendered dimmed. Cards are
  **non-interactive placeholders this round** — no navigation wired yet.
- **Status bar** along the bottom (~60px), mirroring the `/status` bar styling:
  large monospace **time** + **date**, then **Host** and **Portal: Registered**.

Chosen layout (validated in the visual companion): **dark theme, 2×2 cards,
status bar at the bottom** (companion option A).

The other registration states (loading, `pre_registered` pairing screen,
`revoked`) are **unchanged**.

## Non-Goals

- No card navigation/behavior yet (placeholders only).
- No backend/API changes — all data already comes from existing endpoints.
- No changes to the loading / pairing / revoked screens.
- No IP, timezone, or RFID traffic-light in this status bar (kept minimal:
  time/date, host, portal registration).

## Design

### Resolution constraint (800×480, no overflow)

The screen must never exceed the panel. Use full-viewport sizing with clipping
rather than hardcoded pixels: `h-screen w-screen overflow-hidden` on the root
container (on the kiosk the viewport *is* 800×480). Internal layout is a flex
column: the card grid takes remaining height (`flex-1`), the status bar is a
fixed-height row. Paddings, gaps, icon and font sizes are tuned to fit at
480px height and verified on the actual Pi panel. Nothing scrolls.

### Components

- **`portal/src/app/page.tsx`** — in the `registered` branch, replace
  `<LogoShell />` with `<KioskHome />`. One-line swap; all other branches and
  the polling logic stay as-is.
- **`portal/src/components/KioskHome.tsx`** (new) — the home screen. Contains:
  - A client clock (`useEffect` + `setInterval`, 1s), formatting time + date
    the same way `/status` does.
  - A `host` fetch from `/local/settings` (same endpoint `/status` reads;
    `cache: "no-store"`), with a graceful fallback (e.g. "…") on failure.
  - `HomeStatusBar` sub-component — bottom bar: time/date (mono, tabular-nums),
    `Host`, and `Portal: Registered` (green). Visually mirrors `/status`'s bar
    but is its own small unit (the two pages are not code-coupled).
  - `HomeCard` sub-component — `{ icon, title, dimmed? }`; renders the
    `rounded-2xl bg-zinc-900 border border-zinc-800` card with the icon
    centered above the title. `dimmed` applies reduced opacity for "Un-Used".
  - A static array of the four cards drives the grid.

### Icons

From `lucide-react` (already a dependency): **Rocket** (Initial Setup),
**Settings** (Config), **Globe** (Internet), **SquareDashed** (Un-Used). Exact
export names are verified at build time on the Pi; any can be swapped trivially.
If a chosen name isn't exported by the installed version, pick the closest
equivalent (e.g. `Square` for the placeholder) — the build is the check.

### Data flow

`page.tsx` already polls `/local/status` and only mounts `KioskHome` when
`registered`, so the portal-registration value is known. `KioskHome` owns its
own clock and its own `/local/settings` host fetch. No props strictly required;
registration label is constant ("Registered") on this branch.

## Testing & verification

No backend or test-suite changes (the portal has no JS test runner). The
verification gates are:

- **Build**: `npm ci && npm run build` on the Pi (TypeScript/compile gate —
  catches bad `lucide-react` imports).
- **Visual**: the `/` home on the actual 800×480 panel when the device is
  registered — confirm the 2×2 cards + bottom bar fit with no overflow/scroll,
  time ticks, host and portal show correctly.

Per `portal/AGENTS.md`, consult the bundled Next docs on the Pi if any
framework specifics arise.

## Deployment

Deploy via `scripts/test_deploy.sh` (rsyncs the working tree, builds on the Pi,
restarts services). Verify on the panel, then commit. User-authorized deploy to
the Pi at 10.10.48.167.
