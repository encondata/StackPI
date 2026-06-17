"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRevocationGuard } from "@/hooks/useRevocationGuard";
import { KioskStatusBar } from "@/components/KioskStatusBar";

// Leaflet touches `window` at import time — defer to client-only.
const TruckMap = dynamic(() => import("./TruckMap"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-zinc-900" />,
});

type Connection = { type?: string; device?: string; ip4?: string };

type SettingsLite = {
  hostname?: string;
  wan_ip?: string | null;
  connections?: Connection[];
  uptime_seconds?: number | null;
};

type Metrics = {
  total_trucks?: number;
  trucks_in_motion?: number;
  next_truck_eta?: string;
  last_update?: string;
  pending_sync?: number;
  last_sync?: string;
  errors_24h?: number;
};

const METRICS_REFRESH_MS = 5000;

function metric(value: number | string | undefined | null): string {
  if (value == null) return "—";
  return typeof value === "number" ? value.toLocaleString() : value;
}

// Sample data for the Truck Updates panel until the backend feed exists.
type TruckUpdate = {
  name: string;
  time: string;
  lat: number;
  lng: number;
  city: string;
};

const SAMPLE_TRUCK_UPDATES: TruckUpdate[] = [
  { name: "Truck 01", time: "14:23:05", lat: 32.7767, lng: -96.7970,  city: "Dallas, TX" },
  { name: "Truck 02", time: "14:22:48", lat: 34.0522, lng: -118.2437, city: "Los Angeles, CA" },
  { name: "Truck 03", time: "14:22:15", lat: 40.7128, lng: -74.0060,  city: "New York, NY" },
  { name: "Truck 04", time: "14:21:50", lat: 41.8781, lng: -87.6298,  city: "Chicago, IL" },
];

function formatUptime(s: number | null | undefined): string {
  if (s == null || s < 0) return "—";
  if (s < 60) return `${Math.floor(s)}s`;
  const totalMin = Math.floor(s / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const mRem = totalMin % 60;
  if (totalHr < 24) return `${totalHr}h ${mRem}m`;
  const d = Math.floor(totalHr / 24);
  const hRem = totalHr % 24;
  return `${d}d ${hRem}h`;
}

export default function TrucksPage() {
  useRevocationGuard();
  const [uptimeBase, setUptimeBase] = useState<{
    seconds: number;
    atMs: number;
  } | null>(null);
  const [uptimeNow, setUptimeNow] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<Metrics>({});

  // Metrics — same WebSocket swap point as /status.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch("/local/metrics", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as Metrics;
          setMetrics(d);
        }
      } catch {
        /* keep last value */
      }
    }
    tick();
    const id = setInterval(tick, METRICS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!uptimeBase) return;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - uptimeBase.atMs) / 1000);
      setUptimeNow(uptimeBase.seconds + elapsed);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [uptimeBase]);

  // Uptime for the Uptime metric card. (Host/IP/WAN/timezone are fetched by
  // the shared KioskStatusBar itself.)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/settings", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as SettingsLite;
          if (typeof d.uptime_seconds === "number") {
            setUptimeBase({ seconds: d.uptime_seconds, atMs: Date.now() });
          }
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
    <main className="grid h-screen w-screen grid-rows-12 gap-3 overflow-hidden bg-zinc-950 p-3 text-zinc-100">
      {/* ── Top: 8 metric cards (2/12) ────────────────────────────────── */}
      <section className="row-span-2 grid grid-cols-8 gap-3">
        <MetricCard label="Total Trucks"     value={metric(metrics.total_trucks)} />
        <MetricCard label="Trucks In Motion" value={metric(metrics.trucks_in_motion)} />
        <MetricCard label="Next Truck ETA"   value={metric(metrics.next_truck_eta)} />
        <MetricCard label="Last Update"      value={metric(metrics.last_update)} />
        <MetricCard label="Un-Used" value="—" />
        <MetricCard label="Un-Used" value="—" />
        <MetricCard label="Un-Used" value="—" />
        <MetricCard label="Uptime"           value={formatUptime(uptimeNow)} />
      </section>

      {/* ── Middle: map (5/8) + System Events (3/8), spanning 9/12 ──── */}
      <section className="row-span-9 grid grid-cols-8 gap-3">
        <div className="col-span-5 h-full">
          <MapPanel title="Fleet Map">
            <TruckMap trucks={SAMPLE_TRUCK_UPDATES} />
          </MapPanel>
        </div>
        <div className="col-span-3 h-full">
          <LogPanel title="Truck Updates">
            <div className="flex h-full flex-col font-mono">
              {/* column headers — same grid template as the rows below */}
              <div className="grid grid-cols-[96px_88px_176px_1fr] gap-x-5 border-b border-zinc-800 pb-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-600">
                <span>Truck</span>
                <span>Time</span>
                <span>GPS</span>
                <span>City</span>
              </div>
              <ul className="divide-y divide-zinc-800/60 text-sm">
                {SAMPLE_TRUCK_UPDATES.map((u) => (
                  <li
                    key={u.name}
                    className="grid grid-cols-[96px_88px_176px_1fr] items-center gap-x-5 py-2.5"
                  >
                    <span className="font-semibold text-zinc-100">
                      {u.name}
                    </span>
                    <span className="tabular-nums text-zinc-500">
                      {u.time}
                    </span>
                    <span className="tabular-nums text-zinc-400">
                      {u.lat.toFixed(4)}, {u.lng.toFixed(4)}
                    </span>
                    <span className="truncate text-zinc-300">{u.city}</span>
                  </li>
                ))}
              </ul>
            </div>
          </LogPanel>
        </div>
      </section>

      {/* ── Bottom: status bar (1/12) — shared with /status ──────────── */}
      <section className="row-span-1">
        <KioskStatusBar />
      </section>
    </main>
  );
}

// Module-scoped so the function identity is stable across TrucksPage renders.
// Defining this inside TrucksPage gives it a new identity per render, which
// makes React unmount/remount the entire Leaflet subtree on every clock tick.
const MapPanel = function MapPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-400">
          {title}
        </h2>
        <span className="text-[10px] uppercase tracking-widest text-zinc-600">
          osm
        </span>
      </header>
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
};

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 px-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </p>
      <p className="mt-1 font-mono text-5xl leading-none tabular-nums text-zinc-100">
        {value}
      </p>
    </div>
  );
}

function LogPanel({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-400">
          {title}
        </h2>
        <span className="text-[10px] uppercase tracking-widest text-zinc-600">
          live
        </span>
      </header>
      <div className="flex-1 overflow-hidden p-3 font-mono text-xs text-zinc-500">
        {children ?? <p>(no entries yet)</p>}
      </div>
    </div>
  );
}

