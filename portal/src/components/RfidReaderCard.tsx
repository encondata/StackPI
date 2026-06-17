"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RadioTower } from "lucide-react";
import { FullScreenFlash, type ReaderFlash } from "./FullScreenFlash";
import {
  ChangeBorder,
  toChangeBorderStyle,
  type ChangeBorderStyle,
} from "./ChangeBorder";

// The home screen's 4th card. Dual-purpose:
//   1. Shows a stoplight for the "active reader" (the one chosen in Initial
//      Setup) — Reading / Online / Offline / Not set up.
//   2. Tapping toggles start/stop reading on that reader, then flashes a
//      full-screen confirmation.
//
// Status comes from GET /local/rfid/active-reader, a pure DB read that
// reflects whatever the existing poll script last wrote — we re-read it on a
// light interval (no reader contact). Start/stop hit the reader directly and
// we re-read status right after so the dot updates immediately.

type ActiveReader =
  | { configured: false; state: "unconfigured"; name?: string }
  | {
      configured: true;
      reader_id: number;
      name: string;
      enabled?: boolean;
      state: "offline" | "degraded" | "online" | "reading";
      last_status_at?: string | null;
      last_error?: string | null;
    };

const POLL_MS = 10_000;

// Colors follow the /status page traffic light: red / yellow / blue / green.
const STATE_UI: Record<string, { label: string; dot: string; text: string }> = {
  reading: { label: "Reading", dot: "bg-green-500", text: "text-green-400" },
  online: { label: "Online", dot: "bg-blue-500", text: "text-blue-400" },
  degraded: { label: "Degraded", dot: "bg-yellow-400", text: "text-yellow-300" },
  offline: { label: "Offline", dot: "bg-red-500", text: "text-red-400" },
  unconfigured: { label: "Not set up", dot: "bg-zinc-600", text: "text-zinc-400" },
};

// Chase-border settings, shared with the /status page (operator-configured on
// /config/settings/screen-status). Defaults mirror the backend defaults.
type ChaseCfg = {
  color: string;
  widthPx: number;
  cycleCount: number;
  style: ChangeBorderStyle;
};

const CHASE_DEFAULT: ChaseCfg = {
  color: "#22c55e",
  widthPx: 10,
  cycleCount: 2,
  style: "comet",
};

export function RfidReaderCard() {
  const router = useRouter();
  const [data, setData] = useState<ActiveReader | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<ReaderFlash | null>(null);
  const [chase, setChase] = useState<ChaseCfg>(CHASE_DEFAULT);
  const nonceRef = useRef(0);

  // Load the same change-border settings /status uses, so the reading
  // animation matches. Re-read periodically so a saved change takes effect.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/settings/screen-status", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as {
            change_border_color?: string;
            change_border_width_px?: number;
            change_border_cycle_count?: number;
            change_border_style?: string;
          };
          setChase({
            color: d.change_border_color ?? CHASE_DEFAULT.color,
            widthPx:
              typeof d.change_border_width_px === "number"
                ? d.change_border_width_px
                : CHASE_DEFAULT.widthPx,
            cycleCount:
              typeof d.change_border_cycle_count === "number"
                ? d.change_border_cycle_count
                : CHASE_DEFAULT.cycleCount,
            style: toChangeBorderStyle(d.change_border_style),
          });
        }
      } catch {
        /* keep current chase config */
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function refresh(): Promise<ActiveReader | null> {
    try {
      const r = await fetch("/local/rfid/active-reader", { cache: "no-store" });
      if (r.ok) {
        const body = (await r.json()) as ActiveReader;
        setData(body);
        return body;
      }
    } catch {
      /* keep last value */
    }
    return null;
  }

  // Light periodic poll of the local (DB-backed) status while mounted.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!cancelled) await refresh();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function fire(variant: ReaderFlash["variant"], message: string) {
    nonceRef.current += 1;
    setFlash({ variant, message, nonce: nonceRef.current });
  }

  async function onTap() {
    if (busy) return;
    // Not configured (or no longer matching a reader) → send them to setup.
    if (!data || !data.configured) {
      router.push("/initial-setup");
      return;
    }
    const action = data.state === "reading" ? "stop" : "start";
    setBusy(true);
    try {
      const r = await fetch(`/local/rfid/readers/${data.reader_id}/${action}`, {
        method: "POST",
      });
      if (r.ok) {
        fire(
          action === "start" ? "started" : "stopped",
          action === "start" ? "Reading Started" : "Reading Stopped",
        );
        await refresh();
      } else {
        fire("error", "Reader Unreachable");
      }
    } catch {
      fire("error", "Reader Unreachable");
    } finally {
      setBusy(false);
    }
  }

  const state = data?.state ?? "offline";
  const ui = STATE_UI[state] ?? STATE_UI.offline;

  return (
    <>
      <button
        type="button"
        onClick={onTap}
        disabled={busy}
        className="relative flex flex-col items-center justify-center gap-2 overflow-visible rounded-2xl border border-zinc-800 bg-zinc-900 disabled:opacity-70"
      >
        {state === "reading" && (
          <ChangeBorder
            loop
            style={chase.style}
            color={chase.color}
            widthPx={chase.widthPx}
            cornerRadiusPx={16}
            cycleCount={Math.max(1, chase.cycleCount)}
          />
        )}
        <RadioTower className="h-12 w-12 text-zinc-400" strokeWidth={1.6} aria-hidden />
        <p className="text-lg font-semibold tracking-tight text-zinc-100">RFID Reader</p>
        <div className="flex items-center gap-2">
          <span
            className={
              "h-3 w-3 rounded-full " +
              ui.dot +
              (state === "reading" ? " animate-pulse" : "")
            }
            aria-hidden
          />
          <span className={"text-sm font-medium " + ui.text}>
            {busy ? "Working…" : ui.label}
          </span>
        </div>
      </button>
      <FullScreenFlash flash={flash} onClear={() => setFlash(null)} />
    </>
  );
}
