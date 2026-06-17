"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Monitor, Volume2, Timer, Download, Home, type LucideIcon } from "lucide-react";
import { ScreensPanel } from "./ScreensPanel";
import { AudioPanel } from "./AudioPanel";
import { TimersPanel } from "./TimersPanel";
import { UpdatePanel } from "./UpdatePanel";

// Touchscreen Config: a 2×2 menu (mirroring the home screen) that swaps to one
// of four panels. Each panel consolidates existing /config functionality for
// the 800×480 touchscreen. Never navigates to the desktop /config/* admin.
type View = "menu" | "screens" | "audio" | "timers" | "update";

const MENU: { view: View; title: string; Icon: LucideIcon }[] = [
  { view: "screens", title: "Screens", Icon: Monitor },
  { view: "audio", title: "Audio", Icon: Volume2 },
  { view: "timers", title: "Timers", Icon: Timer },
  { view: "update", title: "Update", Icon: Download },
];

export function DeviceConfig() {
  const router = useRouter();
  const [view, setView] = useState<View>("menu");
  const back = () => setView("menu");

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 p-4 text-zinc-100">
      {view === "menu" ? (
        <>
          <header className="flex h-12 flex-none items-center gap-3">
            <button
              type="button"
              onClick={() => router.push("/")}
              className="flex h-10 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 text-sm font-medium text-zinc-200"
            >
              <Home className="h-4 w-4" /> Home
            </button>
            <h1 className="text-xl font-semibold text-zinc-100">Config</h1>
          </header>
          <section className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-4">
            {MENU.map((m) => (
              <button
                key={m.view}
                type="button"
                onClick={() => setView(m.view)}
                className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900"
              >
                <m.Icon className="h-12 w-12 text-zinc-400" strokeWidth={1.6} aria-hidden />
                <p className="text-lg font-semibold tracking-tight text-zinc-100">{m.title}</p>
              </button>
            ))}
          </section>
        </>
      ) : (
        <div className="min-h-0 flex-1">
          {view === "screens" && <ScreensPanel onBack={back} />}
          {view === "audio" && <AudioPanel onBack={back} />}
          {view === "timers" && <TimersPanel onBack={back} />}
          {view === "update" && <UpdatePanel onBack={back} />}
        </div>
      )}
    </main>
  );
}
