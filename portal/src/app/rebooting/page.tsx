"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

const POLL_INTERVAL_MS = 3_000;
const POLL_PATH = "/local/status";
const REDIRECT_TO = "/config";
// We wait for two consecutive successful polls so we don't redirect during
// the brief window where systemd has the API up but the Pi is still booting
// other services.
const SUCCESSES_REQUIRED = 2;

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function RebootingPage() {
  const [elapsed, setElapsed] = useState(0);
  const [phase, setPhase] = useState<"waiting" | "responding" | "redirecting">(
    "waiting"
  );
  const successesRef = useRef(0);

  // Elapsed seconds counter
  useEffect(() => {
    const id = window.setInterval(() => setElapsed((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Reachability polling
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function tick() {
      try {
        const res = await fetch(POLL_PATH, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (cancelled) return;
        if (res.status < 500) {
          successesRef.current += 1;
          if (successesRef.current >= SUCCESSES_REQUIRED) {
            setPhase("redirecting");
            window.setTimeout(() => {
              window.location.replace(REDIRECT_TO);
            }, 1200);
            return;
          }
          setPhase("responding");
        } else {
          successesRef.current = 0;
        }
      } catch {
        // Network error is expected during reboot — reset streak.
        successesRef.current = 0;
      }
    }
    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, []);

  const heading =
    phase === "redirecting"
      ? "Back online"
      : phase === "responding"
        ? "Coming up…"
        : "Rebooting…";
  const detail =
    phase === "redirecting"
      ? "Redirecting to /config."
      : phase === "responding"
        ? "Confirming services are stable…"
        : "The page will return automatically when the Pi is reachable.";

  return (
    <main className="flex h-screen w-full flex-col items-center justify-center gap-6 overflow-hidden bg-white p-8">
      <Image
        src="/stackpi-logo.png"
        alt="StackPI"
        width={1200}
        height={800}
        priority
        sizes="(max-width: 640px) 70vw, 380px"
        className="h-auto w-full max-w-[380px] object-contain"
      />
      <div className="flex flex-col items-center gap-2">
        <p className="text-base font-semibold text-zinc-900">{heading}</p>
        <p className="font-mono text-4xl tabular-nums text-zinc-700">
          {fmt(elapsed)}
        </p>
      </div>
      <p className="max-w-md text-center text-sm text-zinc-500">{detail}</p>
    </main>
  );
}
