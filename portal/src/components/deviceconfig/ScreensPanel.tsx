"use client";

import { useEffect, useState } from "react";
import { PanelShell, Select, Banner } from "./panelChrome";

// Screen options map to local_app_settings default_screen/selector values.
// "Truck" is the label; the stored value is "trucks".
const SCREEN_OPTIONS = [
  { label: "Clock", value: "clock" },
  { label: "Status", value: "status" },
  { label: "Truck", value: "trucks" },
  { label: "Cycle", value: "cycle" },
];

// HDMI1=info1, HDMI2=info2, Touchscreen=touch.
const OUTPUTS = [
  { id: "info1", label: "HDMI 1" },
  { id: "info2", label: "HDMI 2" },
  { id: "touch", label: "Touchscreen" },
];

export function ScreensPanel({ onBack }: { onBack: () => void }) {
  const [sel, setSel] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const o of OUTPUTS) {
        try {
          const r = await fetch(`/local/screens/${o.id}`, { cache: "no-store" });
          if (r.ok) {
            const c = (await r.json()) as { selector?: string; default_screen?: string };
            next[o.id] = c.selector ?? c.default_screen ?? "clock";
          }
        } catch {
          /* leave unset */
        }
      }
      if (!cancelled) setSel(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function flash(kind: "success" | "error", text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 3000);
  }

  // Persist on change — set both default_screen and selector so the choice
  // takes effect live and as the default.
  async function choose(id: string, value: string) {
    const prev = sel[id];
    setSel((s) => ({ ...s, [id]: value }));
    setBusy(id);
    try {
      const r = await fetch(`/local/screens/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_screen: value, selector: value }),
      });
      if (!r.ok) {
        setSel((s) => ({ ...s, [id]: prev }));
        flash("error", "Failed to save.");
      }
    } catch {
      setSel((s) => ({ ...s, [id]: prev }));
      flash("error", "Failed to save.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <PanelShell title="Screens" onBack={onBack}>
      <div className="space-y-4">
        {banner && <Banner kind={banner.kind} text={banner.text} />}
        {OUTPUTS.map((o) => (
          <div key={o.id}>
            <p className="mb-1 text-sm font-medium text-zinc-400">{o.label}</p>
            <Select
              value={sel[o.id] ?? "clock"}
              options={SCREEN_OPTIONS}
              disabled={busy === o.id || !(o.id in sel)}
              onChange={(v) => choose(o.id, v)}
            />
          </div>
        ))}
      </div>
    </PanelShell>
  );
}
