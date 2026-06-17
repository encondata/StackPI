"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FlashAlertOverlay } from "@/components/FlashAlertOverlay";
import { RfidReaderCard } from "@/components/RfidReaderCard";
import {
  Rocket,
  Settings,
  Globe,
  type LucideIcon,
} from "lucide-react";

// The first three home cards. "Internet" navigates to /internet; the others
// are placeholders for now. The 4th cell is the live RFID Reader card
// (status + start/stop), rendered separately below. Icons are from
// lucide-react (already a dependency).
type HomeCardDef = { title: string; Icon: LucideIcon; dimmed?: boolean; href?: string };

const HOME_CARDS: HomeCardDef[] = [
  { title: "Initial Setup", Icon: Rocket, href: "/initial-setup" },
  { title: "Config", Icon: Settings, href: "/device-config" },
  { title: "Internet", Icon: Globe, href: "/internet" },
];

// Shown on / when the device is registered. 800×480 touchscreen home:
// a centered 2×2 card grid over a bottom status bar mirroring /status.
export function KioskHome({ offline = false }: { offline?: boolean }) {
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
      <FlashAlertOverlay />
      <section className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-4">
        {HOME_CARDS.map((c) => (
          <HomeCard
            key={c.title}
            title={c.title}
            Icon={c.Icon}
            dimmed={c.dimmed}
            href={c.href}
          />
        ))}
        <RfidReaderCard />
      </section>
      <HomeStatusBar time={time} dateStr={dateStr} host={host} offline={offline} />
    </main>
  );
}

function HomeCard({
  title,
  Icon,
  dimmed = false,
  href,
}: {
  title: string;
  Icon: LucideIcon;
  dimmed?: boolean;
  href?: string;
}) {
  const cls =
    "flex flex-col items-center justify-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 " +
    (dimmed ? "opacity-50" : "");
  const inner = (
    <>
      <Icon className="h-12 w-12 text-zinc-400" strokeWidth={1.6} aria-hidden />
      <p className="text-lg font-semibold tracking-tight text-zinc-100">{title}</p>
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  }
  return <div className={cls}>{inner}</div>;
}

function HomeStatusBar({
  time,
  dateStr,
  host,
  offline = false,
}: {
  time: string;
  dateStr: string;
  host: string;
  offline?: boolean;
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
        <p
          className={
            "text-lg font-medium leading-tight " +
            (offline ? "text-amber-400" : "text-green-400")
          }
        >
          {offline ? "Offline" : "Registered"}
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
