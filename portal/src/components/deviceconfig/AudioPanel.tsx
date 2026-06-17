"use client";

import { useEffect, useState } from "react";
import { PanelShell, Select, Banner } from "./panelChrome";

// Reuses /local/alerts/config (notification sound + volume) and
// /local/alerts/test. Debounce stays on the desktop /config — this simplified
// touch panel only exposes volume + sound + test, and round-trips the existing
// debounce value unchanged on save (the POST requires all three fields).
type Cfg = {
  sound_file: string;
  volume_pct: number;
  debounce_seconds: number;
  sounds: string[];
};

export function AudioPanel({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [sound, setSound] = useState("");
  const [volume, setVolume] = useState(80);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/local/alerts/config", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const b = (await r.json()) as Cfg;
          setCfg(b);
          setSound(b.sound_file);
          setVolume(b.volume_pct);
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
    window.setTimeout(() => setBanner(null), 3000);
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    try {
      const r = await fetch("/local/alerts/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sound_file: sound,
          volume_pct: volume,
          debounce_seconds: cfg.debounce_seconds,
        }),
      });
      if (r.ok) {
        setCfg((await r.json()) as Cfg);
        flash("success", "Saved.");
      } else {
        flash("error", "Failed to save.");
      }
    } catch {
      flash("error", "Failed to save.");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    try {
      await fetch("/local/alerts/test", { method: "POST" });
    } catch {
      /* ignore */
    }
  }

  return (
    <PanelShell
      title="Audio"
      onBack={onBack}
      footer={
        <>
          <button
            type="button"
            onClick={test}
            disabled={!cfg}
            className="h-10 rounded-lg border border-zinc-700 bg-zinc-800 px-4 text-sm font-medium text-zinc-200 disabled:opacity-50"
          >
            Test
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !cfg}
            className="h-10 rounded-lg bg-blue-600 px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Apply"}
          </button>
        </>
      }
    >
      <div className="space-y-6">
        {banner && <Banner kind={banner.kind} text={banner.text} />}
        <div>
          <p className="mb-2 text-sm font-medium text-zinc-400">
            Notification volume ({volume}%)
          </p>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={volume}
            disabled={!cfg}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-full"
          />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-zinc-400">Notification sound</p>
          <Select
            value={sound}
            disabled={!cfg}
            onChange={setSound}
            options={(cfg?.sounds ?? []).map((s) => ({ label: s, value: s }))}
          />
        </div>
      </div>
    </PanelShell>
  );
}
