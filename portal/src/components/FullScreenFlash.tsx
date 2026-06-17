"use client";

import { useEffect, useRef } from "react";
import { CircleCheck, CirclePause, TriangleAlert } from "lucide-react";

// A full-screen, prop-driven confirmation flash. Distinct from
// FlashAlertOverlay (which is SSE-driven and reserved for bad-tag danger):
// this one is triggered directly by an action result — currently the home
// RFID Reader card's start/stop. Pass a new `flash` object (bump `nonce`) to
// show it; it auto-clears after ~2.5s and calls onClear.
export type ReaderFlash = {
  variant: "started" | "stopped" | "error";
  message: string;
  nonce: number;
};

const FLASH_MS = 2500;

const VARIANTS = {
  started: { bg: "bg-green-600/90", Icon: CircleCheck },
  stopped: { bg: "bg-slate-600/90", Icon: CirclePause },
  error: { bg: "bg-red-600/90", Icon: TriangleAlert },
} as const;

export function FullScreenFlash({
  flash,
  onClear,
}: {
  flash: ReaderFlash | null;
  onClear: () => void;
}) {
  // Keep the latest onClear without making it a re-arm trigger.
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;

  // Re-arm the auto-clear timer whenever a new flash arrives (new object).
  useEffect(() => {
    if (flash == null) return;
    const t = window.setTimeout(() => onClearRef.current(), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [flash]);

  if (!flash) return null;
  const { bg, Icon } = VARIANTS[flash.variant];
  return (
    <div
      key={flash.nonce}
      role="status"
      aria-live="assertive"
      className={
        "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 animate-pulse " +
        bg
      }
    >
      <Icon className="h-28 w-28 text-white" strokeWidth={1.5} aria-hidden />
      <p className="max-w-[90%] text-center text-4xl font-bold leading-tight text-white">
        {flash.message}
      </p>
    </div>
  );
}
