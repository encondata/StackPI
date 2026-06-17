"use client";

import { useEffect, useState } from "react";
import { useRevocationGuard } from "@/hooks/useRevocationGuard";

type SettingsLite = { hostname?: string };

export default function ClockPage() {
  useRevocationGuard();
  const [hostname, setHostname] = useState<string>("…");
  const [clock, setClock] = useState<string>("");
  const [dateStr, setDateStr] = useState<string>("");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(
        d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
      setDateStr(
        d.toLocaleDateString([], {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/settings", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as SettingsLite;
          if (d?.hostname) setHostname(d.hostname);
        }
      } catch {
        /* keep last good value */
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <main className="flex h-screen w-screen flex-col items-center justify-center overflow-hidden bg-zinc-950 text-zinc-100">
      <p className="font-mono text-3xl uppercase tracking-[0.4em] text-zinc-500">
        {hostname}
      </p>
      <p className="mt-10 font-mono text-[12rem] leading-none tabular-nums">
        {clock}
      </p>
      <p className="mt-8 text-2xl text-zinc-400">{dateStr}</p>
      <p className="mt-16 text-xs uppercase tracking-[0.5em] text-zinc-700">
        clock
      </p>
    </main>
  );
}
