"use client";

import { useEffect, useState } from "react";
import { PanelShell, Stepper, Banner } from "./panelChrome";

// Screen Cycle Timer → /local/screens/cycle-seconds (new setting).
// RFID Polling Refresh → /local/rfid/settings (existing rfid_polling_refresh_minutes).
export function TimersPanel({ onBack }: { onBack: () => void }) {
  const [cycle, setCycle] = useState<number | null>(null);
  const [cycleMin, setCycleMin] = useState(3);
  const [cycleMax, setCycleMax] = useState(600);
  const [rfid, setRfid] = useState<number | null>(null);
  const [rfidMin, setRfidMin] = useState(1);
  const [rfidMax, setRfidMax] = useState(1440);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/local/screens/cycle-seconds", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const b = (await r.json()) as {
            cycle_seconds: number;
            cycle_seconds_min: number;
            cycle_seconds_max: number;
          };
          setCycle(b.cycle_seconds);
          setCycleMin(b.cycle_seconds_min);
          setCycleMax(b.cycle_seconds_max);
        }
      } catch {
        /* keep null */
      }
      try {
        const r = await fetch("/local/rfid/settings", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const b = (await r.json()) as {
            rfid_polling_refresh_minutes: number;
            rfid_polling_refresh_minutes_min: number;
            rfid_polling_refresh_minutes_max: number;
          };
          setRfid(b.rfid_polling_refresh_minutes);
          setRfidMin(b.rfid_polling_refresh_minutes_min);
          setRfidMax(b.rfid_polling_refresh_minutes_max);
        }
      } catch {
        /* keep null */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function flash(kind: "success" | "error", text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 3000);
  }

  async function save() {
    if (cycle == null || rfid == null) return;
    setBusy(true);
    let ok = true;
    try {
      const r = await fetch("/local/screens/cycle-seconds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycle_seconds: cycle }),
      });
      if (!r.ok) ok = false;
    } catch {
      ok = false;
    }
    try {
      const r = await fetch("/local/rfid/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfid_polling_refresh_minutes: rfid }),
      });
      if (!r.ok) ok = false;
    } catch {
      ok = false;
    }
    setBusy(false);
    flash(ok ? "success" : "error", ok ? "Saved." : "Failed to save.");
  }

  return (
    <PanelShell
      title="Timers"
      onBack={onBack}
      footer={
        <button
          type="button"
          onClick={save}
          disabled={busy || cycle == null || rfid == null}
          className="h-10 rounded-lg bg-blue-600 px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Apply"}
        </button>
      }
    >
      <div className="space-y-6">
        {banner && <Banner kind={banner.kind} text={banner.text} />}
        <div>
          <p className="mb-1 text-sm font-medium text-zinc-200">Screen Cycle Timer</p>
          <p className="mb-3 text-xs text-zinc-500">
            Seconds between the Status and Truck screens when a screen is set to Cycle.
          </p>
          {cycle != null && (
            <Stepper value={cycle} min={cycleMin} max={cycleMax} unit="sec" onChange={setCycle} disabled={busy} />
          )}
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-zinc-200">RFID Polling Refresh</p>
          <p className="mb-3 text-xs text-zinc-500">How often the Pi refreshes reader status.</p>
          {rfid != null && (
            <Stepper value={rfid} min={rfidMin} max={rfidMax} unit="min" onChange={setRfid} disabled={busy} />
          )}
        </div>
      </div>
    </PanelShell>
  );
}
