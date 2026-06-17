"use client";

import { useEffect, useState } from "react";
import { useRevocationGuard } from "@/hooks/useRevocationGuard";

// Wrapper a kiosk display output (HDMI1=info1, HDMI2=info2, Touchscreen=touch)
// loads. Polls /local/screens/{screenId} for the active selection and shows it
// in a full-screen iframe. When the selection is "cycle", it rotates between
// the Status and Truck screens every screen_cycle_seconds (a global setting).
// /clock, /status, /trucks remain standalone routes (still visitable directly).

const SCREEN_URLS: Record<string, string> = {
  clock: "/clock",
  status: "/status",
  trucks: "/trucks",
  off: "about:blank",
};

// The Status↔Truck rotation used when a screen is set to "cycle".
const CYCLE_SCREENS = ["/status", "/trucks"];

const POLL_MS = 3000; // selector poll
const CYCLE_CONFIG_POLL_MS = 30_000; // re-read the cycle interval occasionally

type ScreenConfig = { default_screen?: string; selector?: string };

export function ScreenRenderer({ screenId }: { screenId: string }) {
  useRevocationGuard();
  const [selection, setSelection] = useState<string>("clock");
  const [cycleSeconds, setCycleSeconds] = useState<number>(15);
  const [cycleIdx, setCycleIdx] = useState<number>(0);

  // Poll this screen's active selection.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch(`/local/screens/${screenId}`, { cache: "no-store" });
        if (!cancelled && r.ok) {
          const cfg = (await r.json()) as ScreenConfig;
          const next = cfg.selector ?? cfg.default_screen ?? "clock";
          setSelection((cur) => (cur === next ? cur : next));
        }
      } catch {
        /* keep last known selection */
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [screenId]);

  // Re-read the global cycle interval (only matters while cycling).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/screens/cycle-seconds", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const b = (await r.json()) as { cycle_seconds?: number };
          if (typeof b.cycle_seconds === "number") setCycleSeconds(b.cycle_seconds);
        }
      } catch {
        /* keep last known interval */
      }
    }
    load();
    const id = setInterval(load, CYCLE_CONFIG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Drive the rotation when this screen is set to "cycle".
  useEffect(() => {
    if (selection !== "cycle") return;
    setCycleIdx(0); // start on Status each time cycling (re)starts
    const id = setInterval(() => {
      setCycleIdx((i) => (i + 1) % CYCLE_SCREENS.length);
    }, Math.max(3, cycleSeconds) * 1000);
    return () => clearInterval(id);
  }, [selection, cycleSeconds]);

  const url =
    selection === "cycle"
      ? CYCLE_SCREENS[cycleIdx]
      : SCREEN_URLS[selection] ?? "/clock";

  return (
    <iframe
      src={url}
      title={`Screen ${screenId}`}
      className="block h-screen w-screen border-0"
    />
  );
}
