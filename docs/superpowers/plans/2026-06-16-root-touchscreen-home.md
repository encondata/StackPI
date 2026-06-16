# Root Touchscreen Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the device is `registered`, render an 800×480 touchscreen home on `/` — a 2×2 grid of four placeholder config cards over a bottom status bar that mirrors `/status` (time/date, host, portal).

**Architecture:** A new self-contained `KioskHome` client component replaces the logo-only `LogoShell` in the `registered` branch of `portal/src/app/page.tsx`. It owns its own clock and host fetch; the other registration states are untouched. No backend changes.

**Tech Stack:** Next.js 16 / React 19 (TypeScript), Tailwind, `lucide-react` icons. Builds/verification happen on the Pi.

---

## Important constraints

- **No local builds.** Do not run `npm install` / `npm run build` / `npm run dev` on the Mac. Build + verify on the Pi via `scripts/test_deploy.sh`.
- **800×480, no overflow:** the root uses `h-screen w-screen overflow-hidden`; the card grid is `flex-1` and the bar is a fixed-height row, so it fits the panel and clips rather than scrolling.
- Per `portal/AGENTS.md`, this Next.js has breaking changes from common knowledge; the existing files already compile under it, so follow their patterns.

## File Structure

- **Create** `portal/src/components/KioskHome.tsx` — the home screen: `KioskHome` (clock + host fetch + layout), `HomeStatusBar`, `HomeCard`, and a small `Field` helper.
- **Modify** `portal/src/app/page.tsx` — import `KioskHome`, render it in the `registered` branch, remove the now-unused `LogoShell`.

---

### Task 1: Create the `KioskHome` component

**Files:**
- Create: `portal/src/components/KioskHome.tsx`

- [ ] **Step 1: Create `portal/src/components/KioskHome.tsx` with exactly this content:**

```tsx
"use client";

import { useEffect, useState } from "react";
import {
  Rocket,
  Settings,
  Globe,
  SquareDashed,
  type LucideIcon,
} from "lucide-react";

// The four home cards. Placeholders this round — no navigation. "Un-Used"
// is rendered dimmed. Icons are from lucide-react (already a dependency).
type HomeCardDef = { title: string; Icon: LucideIcon; dimmed?: boolean };

const HOME_CARDS: HomeCardDef[] = [
  { title: "Initial Setup", Icon: Rocket },
  { title: "Config", Icon: Settings },
  { title: "Internet", Icon: Globe },
  { title: "Un-Used", Icon: SquareDashed, dimmed: true },
];

// Shown on / when the device is registered. 800×480 touchscreen home:
// a centered 2×2 card grid over a bottom status bar mirroring /status.
export function KioskHome() {
  const [time, setTime] = useState<string>("");
  const [dateStr, setDateStr] = useState<string>("");
  const [host, setHost] = useState<string>("…");

  // Client clock — same formatting as /status.
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(
        d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
      );
      setDateStr(
        d.toLocaleDateString([], {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Hostname — same endpoint /status reads. Keeps last value on failure.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/settings", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as { hostname?: string };
          if (d?.hostname) setHost(d.hostname);
        }
      } catch {
        /* keep last value */
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex h-screen w-screen flex-col gap-4 overflow-hidden bg-zinc-950 p-4 text-zinc-100">
      <section className="grid flex-1 grid-cols-2 grid-rows-2 gap-4">
        {HOME_CARDS.map((c) => (
          <HomeCard key={c.title} title={c.title} Icon={c.Icon} dimmed={c.dimmed} />
        ))}
      </section>
      <HomeStatusBar time={time} dateStr={dateStr} host={host} />
    </main>
  );
}

function HomeCard({
  title,
  Icon,
  dimmed = false,
}: {
  title: string;
  Icon: LucideIcon;
  dimmed?: boolean;
}) {
  return (
    <div
      className={
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 " +
        (dimmed ? "opacity-50" : "")
      }
    >
      <Icon className="h-12 w-12 text-zinc-400" strokeWidth={1.6} aria-hidden />
      <p className="text-lg font-semibold tracking-tight text-zinc-100">{title}</p>
    </div>
  );
}

function HomeStatusBar({
  time,
  dateStr,
  host,
}: {
  time: string;
  dateStr: string;
  host: string;
}) {
  return (
    <div className="flex h-[60px] shrink-0 items-center gap-6 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 px-5 font-mono">
      <p className="text-3xl leading-none tabular-nums text-zinc-100">
        {time || "—"}
      </p>
      <p className="text-sm tabular-nums text-zinc-400">{dateStr}</p>
      <div className="flex-1" />
      <Field label="Host" value={host} />
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
          Portal
        </p>
        <p className="text-lg font-medium leading-tight text-green-400">
          Registered
        </p>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
        {label}
      </p>
      <p className="text-lg leading-tight text-zinc-100">{value}</p>
    </div>
  );
}
```

- [ ] **Step 2: Verify the lucide-react icon names resolve**

Run: `grep -n "Rocket\|Globe\|SquareDashed\|Settings" portal/src/components/KioskHome.tsx`
Expected: the import line and usages present. NOTE: the actual existence of `Rocket`/`Globe`/`SquareDashed` exports is confirmed by the Pi build in Task 3 (the repo's `lucide-react` is `^1.17.0`). `Settings` is already used in `Sidebar.tsx`, so it's known-good. If the Pi build reports any of the other three as not exported, substitute the closest available icon (e.g. `Square` for the placeholder, `Wifi` for Internet, `Play`/`Wand2` for Initial Setup) and rebuild — this is the only expected adjustment.

- [ ] **Step 3: Commit**

```bash
cd /Users/jrh1812/Desktop/StackPI_v2
git add portal/src/components/KioskHome.tsx
git commit -m "feat(portal): add KioskHome touchscreen home component"
```

---

### Task 2: Render `KioskHome` in the registered branch

**Files:**
- Modify: `portal/src/app/page.tsx`

- [ ] **Step 1: Read the file** to confirm current structure.

Run: `sed -n '1,60p' portal/src/app/page.tsx`
Expected: an import block at the top; in `KioskHome`/`KioskHome`-style default export, the line `if (data.status === "registered") return <LogoShell />;`; and a `function LogoShell()` defined lower.

- [ ] **Step 2: Add the import**

At the top of `portal/src/app/page.tsx`, after the existing `import { QRCodeSVG } from "qrcode.react";` line, add:

```tsx
import { KioskHome } from "@/components/KioskHome";
```

- [ ] **Step 3: Render KioskHome when registered**

Replace the line:

```tsx
  if (data.status === "registered") return <LogoShell />;
```

with:

```tsx
  if (data.status === "registered") return <KioskHome />;
```

- [ ] **Step 4: Remove the now-unused `LogoShell`**

Delete the entire `function LogoShell() { ... }` definition (it is no longer referenced — leaving it would be dead code and may trip the lint/build). Do NOT remove `LoadingShell`, `RevokedShell`, or `PairingShell` — those are still used.

- [ ] **Step 5: Verify no dangling references**

Run: `grep -n "LogoShell" portal/src/app/page.tsx`
Expected: no output (defined-and-used removed cleanly).
Run: `grep -n "KioskHome" portal/src/app/page.tsx`
Expected: the import and the `return <KioskHome />` usage.

- [ ] **Step 6: Commit**

```bash
cd /Users/jrh1812/Desktop/StackPI_v2
git add portal/src/app/page.tsx
git commit -m "feat(portal): show KioskHome on / when registered"
```

---

### Task 3: Build + verify on the Pi

**Files:** none (deploy + observe)

- [ ] **Step 1: Deploy (rsync + build on the Pi)**

Run from the repo root: `bash scripts/test_deploy.sh`
Expected: rsync completes; `npm ci && npm run build` runs on the Pi and the portal builds successfully (this is the TypeScript/compile gate and confirms the lucide-react icon imports resolve). Script ends with `Test deploy finished — 10.10.48.167`.
If the build fails on a lucide icon name, swap it per Task 1 Step 2, commit, and re-run `scripts/test_deploy.sh` (never build locally).

- [ ] **Step 2: Visual verification on the 800×480 panel**

With the device `registered`, view `/` on the panel and confirm:
1. A 2×2 grid of four cards — Initial Setup (rocket), Config (gear), Internet (globe), Un-Used (dashed square, dimmed) — centered, filling the area above the bar.
2. The bottom status bar shows a ticking time + date, the host, and "Portal: Registered" in green.
3. Everything fits within 800×480 — no scrollbars, nothing clipped off-screen.

(If the device is not currently registered, the home won't show — that's expected; the pairing/loading screens are unchanged.)

---

## Self-Review notes (author)

- **Spec coverage:** registered-only home (Task 2) ✓; 2×2 dark cards + dimmed Un-Used (Task 1) ✓; bottom bar mirroring /status with time/date/host/portal (Task 1) ✓; lucide icons with build-time verification + fallback (Task 1 Step 2 / Task 3) ✓; 800×480 no-overflow via h-screen/w-screen/flex (Task 1) ✓; no backend changes ✓; build + visual verification on Pi (Task 3) ✓.
- **No JS unit tests:** the portal has no test runner (consistent with the prior feature); the compile gate is the Pi build and correctness is visual. Stated honestly rather than fabricating tests.
- **Type consistency:** `KioskHome`, `HomeCard`, `HomeStatusBar`, `Field`, and `HomeCardDef`/`LucideIcon` are used consistently across the single component file; `page.tsx` imports only `KioskHome`.
