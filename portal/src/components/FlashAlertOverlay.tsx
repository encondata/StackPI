"use client";

import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";

// Full-screen flash for bad-tag alerts. Subscribes to the System Events SSE
// and, on a kind="alert" event, throws up a pulsing yellow/red overlay (color
// from the event's `detail` severity) with the message, auto-clearing after a
// few seconds. Mounted on the operator-facing screens (/status and the home).
type ActiveAlert = { message: string; severity: string; nonce: number };

const FLASH_MS = 5000;

export function FlashAlertOverlay() {
  const [alert, setAlert] = useState<ActiveAlert | null>(null);
  const timerRef = useRef<number | null>(null);
  const nonceRef = useRef(0);

  useEffect(() => {
    const es = new EventSource("/local/system-events/stream");
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data) as {
          kind?: string;
          message?: string;
          detail?: string | null;
          replay?: boolean;
        };
        // Only flash on a genuinely new scan — never replay the connect-time
        // backlog on page refresh / SSE reconnect / API restart.
        if (d.kind !== "alert" || d.replay) return;
        nonceRef.current += 1;
        setAlert({
          message: d.message ?? "Alert",
          severity: (d.detail || "critical").toLowerCase(),
          nonce: nonceRef.current,
        });
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setAlert(null), FLASH_MS);
      } catch {
        /* malformed frame */
      }
    };
    return () => {
      es.close();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!alert) return null;
  const warning = alert.severity === "warning";
  const bg = warning ? "bg-amber-500/90" : "bg-red-600/90";
  return (
    <div
      key={alert.nonce}
      role="alert"
      aria-live="assertive"
      className={
        "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 animate-pulse " +
        bg
      }
    >
      <TriangleAlert className="h-28 w-28 text-white" strokeWidth={1.5} aria-hidden />
      <p className="max-w-[90%] text-center text-4xl font-bold leading-tight text-white">
        {alert.message}
      </p>
    </div>
  );
}
