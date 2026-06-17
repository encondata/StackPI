"use client";

import { useEffect, useState } from "react";
import { friendlyTimezone } from "@/lib/timezone";

// Self-contained kiosk status bar — the bottom bar shown on /status and
// /trucks. It fetches everything it needs (clock, host/IP/WAN/timezone from
// /local/settings, registration from /local/status, and the RFID traffic
// light from /local/rfid/readers), so any page can drop in <KioskStatusBar />
// and get an identical, live bar. The RFID light derivation mirrors the
// /status page's per-reader logic exactly.

type RegStatus = "pre_registered" | "registered" | "revoked" | "unknown";

const REG_DISPLAY: Record<RegStatus, { label: string; tone: string }> = {
  registered:     { label: "Registered",     tone: "text-green-400" },
  pre_registered: { label: "Pre-registered", tone: "text-yellow-400" },
  revoked:        { label: "Revoked",        tone: "text-red-400" },
  unknown:        { label: "Unknown",        tone: "text-zinc-400" },
};

type LightState = { red: boolean; yellow: boolean; blue: boolean; green: boolean };

type Connection = { type?: string; device?: string; ip4?: string };
type SettingsLite = {
  hostname?: string;
  wan_ip?: string | null;
  connections?: Connection[];
  timezone?: string | null;
};

const SETTINGS_REFRESH_MS = 30_000;
const REG_REFRESH_MS = 10_000;
const LIGHT_REFRESH_MS = 5_000;

export function KioskStatusBar() {
  const [hostname, setHostname] = useState<string>("…");
  const [ip, setIp] = useState<string>("");
  const [wanIp, setWanIp] = useState<string>("");
  const [timezone, setTimezone] = useState<string>("");
  const [time, setTime] = useState<string>("");
  const [dateStr, setDateStr] = useState<string>("");
  const [reg, setReg] = useState<RegStatus>("unknown");
  const [lightState, setLightState] = useState<LightState>({
    red: false,
    yellow: false,
    blue: false,
    green: false,
  });

  // Clock.
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
        d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }),
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Host / IP / WAN / timezone.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/settings", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as SettingsLite;
          if (d?.hostname) setHostname(d.hostname);
          const first = (d.connections ?? []).find(
            (c) => c.type !== "loopback" && c.device !== "lo" && c.ip4,
          );
          setIp(first?.ip4 ?? "");
          setWanIp(d.wan_ip ?? "");
          setTimezone(friendlyTimezone(d.timezone ?? null));
        }
      } catch {
        /* keep last good value */
      }
    }
    load();
    const id = setInterval(load, SETTINGS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Registration status.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/status", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as { status?: string };
          const s = d?.status;
          setReg(
            s === "registered" || s === "pre_registered" || s === "revoked"
              ? (s as RegStatus)
              : "unknown",
          );
        }
      } catch {
        /* keep last value */
      }
    }
    load();
    const id = setInterval(load, REG_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // RFID traffic light — derived from polled reader status (same logic as
  // /status): red = any reader in error / no status; yellow = reachable but a
  // connector down; blue = all reachable + connected; green = any reader
  // actively reading (green stacks on blue).
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/local/rfid/readers", { cache: "no-store" });
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as {
          readers?: Array<{
            enabled?: boolean;
            last_error?: string | null;
            last_status?: {
              radioActivity?: string;
              radioActivitiy?: string;
              interfaceConnectionStatus?: { data?: Array<{ connectionStatus?: string }> };
            } | null;
          }>;
        };
        let anyRed = false;
        let anyYellow = false;
        let anyReading = false;
        let enabledCount = 0;
        for (const r of body.readers ?? []) {
          if (r.enabled === false) continue;
          enabledCount += 1;
          const activity = r.last_status?.radioActivity ?? r.last_status?.radioActivitiy;
          if (String(activity ?? "").toLowerCase() === "active") anyReading = true;
          if (r.last_error || !r.last_status) {
            anyRed = true;
            continue;
          }
          const interfaces = r.last_status.interfaceConnectionStatus?.data ?? [];
          const allConnected =
            interfaces.length > 0 &&
            interfaces.every(
              (i) => String(i?.connectionStatus ?? "").toLowerCase() === "connected",
            );
          if (!allConnected) anyYellow = true;
        }
        if (cancelled) return;
        if (enabledCount === 0) {
          setLightState({ red: false, yellow: false, blue: false, green: false });
        } else if (anyRed) {
          setLightState({ red: true, yellow: false, blue: false, green: false });
        } else if (anyYellow) {
          setLightState({ red: false, yellow: true, blue: false, green: false });
        } else {
          setLightState({ red: false, yellow: false, blue: true, green: anyReading });
        }
      } catch {
        /* keep last value */
      }
    }
    tick();
    const id = setInterval(tick, LIGHT_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const ipDisplay = ip ? (wanIp ? `${ip} (${wanIp})` : ip) : "—";

  return (
    <div className="grid h-full grid-cols-[1fr_auto] items-center gap-8 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 px-5">
      <div className="flex items-center justify-between gap-6 font-mono">
        <TimeField time={time} dateStr={dateStr} timezone={timezone} />
        <Field label="Host" value={hostname} />
        <Field label="IP" value={ipDisplay} />
        <RegField status={reg} />
      </div>
      <TrafficLight state={lightState} />
    </div>
  );
}

function TimeField({
  time,
  dateStr,
  timezone,
}: {
  time: string;
  dateStr: string;
  timezone: string;
}) {
  return (
    <div className="flex items-center gap-3 font-mono leading-none">
      <p className="text-4xl tabular-nums text-zinc-100">{time || "—"}</p>
      <div className="flex flex-col gap-1">
        <p className="text-base tabular-nums text-zinc-400">{dateStr}</p>
        {timezone && <p className="text-xs tabular-nums text-zinc-500">{timezone}</p>}
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

function RegField({ status }: { status: RegStatus }) {
  const cfg = REG_DISPLAY[status];
  return (
    <div className="flex items-center gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
        Portal
      </p>
      <p className={"text-lg font-medium leading-tight " + cfg.tone}>{cfg.label}</p>
    </div>
  );
}

function TrafficLight({ state }: { state: LightState }) {
  return (
    <div className="flex items-center gap-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
        RFID
      </p>
      <div className="flex items-center gap-2">
        <Dot color="red" active={state.red} />
        <Dot color="yellow" active={state.yellow} />
        <Dot color="blue" active={state.blue} />
        <Dot color="green" active={state.green} />
      </div>
    </div>
  );
}

function Dot({
  color,
  active,
}: {
  color: "red" | "yellow" | "blue" | "green";
  active: boolean;
}) {
  const live: Record<typeof color, string> = {
    red: "bg-red-500 ring-red-400/60 shadow-[0_0_18px_rgba(239,68,68,0.6)]",
    yellow: "bg-yellow-400 ring-yellow-300/60 shadow-[0_0_18px_rgba(250,204,21,0.6)]",
    blue: "bg-blue-500 ring-blue-400/60 shadow-[0_0_18px_rgba(59,130,246,0.6)]",
    green: "bg-green-500 ring-green-400/60 shadow-[0_0_18px_rgba(34,197,94,0.6)]",
  };
  const dim: Record<typeof color, string> = {
    red: "bg-red-950 ring-red-900/40",
    yellow: "bg-yellow-950 ring-yellow-900/40",
    blue: "bg-blue-950 ring-blue-900/40",
    green: "bg-green-950 ring-green-900/40",
  };
  return (
    <span
      className={"block h-5 w-5 rounded-full ring-2 " + (active ? live[color] : dim[color])}
    />
  );
}
