"use client";

import { useEffect, useState } from "react";

// Self-contained "Bad-Tag Alerts" settings section (sound / volume / debounce),
// wired to /local/alerts/config (+ /local/alerts/test). Manages its own state,
// Apply, and Test so it can be dropped onto a settings page without touching
// that page's other save logic.
type AlertConfig = {
  sound_file: string;
  sound_file_default: string;
  volume_pct: number;
  volume_pct_default: number;
  debounce_seconds: number;
  debounce_seconds_default: number;
  debounce_seconds_min: number;
  debounce_seconds_max: number;
  sounds: string[];
};

export function AlertSettingsSection() {
  const [cfg, setCfg] = useState<AlertConfig | null>(null);
  const [sound, setSound] = useState<string>("");
  const [volume, setVolume] = useState<number>(80);
  const [debounce, setDebounce] = useState<string>("30");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/local/alerts/config", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const b = (await r.json()) as AlertConfig;
          setCfg(b);
          setSound(b.sound_file);
          setVolume(b.volume_pct);
          setDebounce(String(b.debounce_seconds));
        }
      } catch {
        /* keep defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function flash(kind: "success" | "error", text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 5000);
  }

  async function save() {
    if (!cfg) return;
    const d = Number.parseInt(debounce, 10);
    if (!Number.isFinite(d) || d < cfg.debounce_seconds_min || d > cfg.debounce_seconds_max) {
      flash("error", `Debounce must be ${cfg.debounce_seconds_min}–${cfg.debounce_seconds_max} seconds.`);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/local/alerts/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sound_file: sound, volume_pct: volume, debounce_seconds: d }),
      });
      const b = (await r.json().catch(() => null)) as AlertConfig | { detail?: string } | null;
      if (r.ok && b && "sound_file" in b) {
        setCfg(b);
        setSound(b.sound_file);
        setVolume(b.volume_pct);
        setDebounce(String(b.debounce_seconds));
        flash("success", "Alert settings saved.");
      } else {
        flash("error", (b as { detail?: string } | null)?.detail ?? "Failed to save alert settings.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    try {
      await fetch("/local/alerts/test", { method: "POST" });
      flash("success", "Played the test sound on the device.");
    } catch {
      flash("error", "Could not play the test sound.");
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold">Bad-Tag Alerts</h2>
      <p className="mt-1 text-sm text-zinc-500">
        When a scanned tag is a known asset that isn&apos;t part of the active move, the device plays a
        sound and flashes the screen. Alerts are debounced per tag.
      </p>

      {banner && (
        <div
          role="status"
          className={`mt-3 rounded-md border px-3 py-2 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {banner.text}
        </div>
      )}

      <div className="mt-5 grid gap-5 sm:grid-cols-3">
        <label className="block">
          <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">Alert sound</span>
          <select
            value={sound}
            disabled={busy || !cfg}
            onChange={(e) => setSound(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-60"
          >
            {(cfg?.sounds ?? ["none"]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
            Volume ({volume}%)
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={volume}
            disabled={busy || !cfg}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="mt-3 w-full"
          />
        </label>

        <label className="block">
          <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">Debounce (s)</span>
          <input
            type="number"
            inputMode="numeric"
            min={cfg?.debounce_seconds_min ?? 5}
            max={cfg?.debounce_seconds_max ?? 300}
            step={1}
            value={debounce}
            disabled={busy || !cfg}
            onChange={(e) => setDebounce(e.target.value)}
            className="mt-1 w-28 rounded-md border border-zinc-300 px-3 py-1.5 text-right font-mono text-sm tabular-nums disabled:opacity-60"
          />
        </label>
      </div>

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={test}
          disabled={busy || !cfg}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
        >
          Test sound
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy || !cfg}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Apply"}
        </button>
      </div>
    </section>
  );
}
