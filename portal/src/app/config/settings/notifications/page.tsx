"use client";

import { useEffect, useState } from "react";

// /config → Settings → Notifications. Configure the multicast target the stack
// lights listen on, and send test light/sound messages. Backed by
// /local/notify/{config,test/light,test/sound}.

type Banner = { kind: "success" | "error"; text: string } | null;

const PATTERNS = ["solid", "flash", "pulse"] as const;
const COLORS = ["red", "green", "yellow", "blue"] as const;

export default function NotificationsPage() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [group, setGroup] = useState("239.10.10.10");
  const [port, setPort] = useState("5005");
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgBanner, setCfgBanner] = useState<Banner>(null);

  // Light test form
  const [pattern, setPattern] = useState<(typeof PATTERNS)[number]>("flash");
  const [color, setColor] = useState<(typeof COLORS)[number]>("red");
  const [brightness, setBrightness] = useState(80);
  const [lightDuration, setLightDuration] = useState(500);
  const [lightRepeat, setLightRepeat] = useState(3);
  const [lightBanner, setLightBanner] = useState<Banner>(null);

  // Sound test form
  const [sound, setSound] = useState("alert");
  const [volume, setVolume] = useState(70);
  const [soundDuration, setSoundDuration] = useState(400);
  const [soundRepeat, setSoundRepeat] = useState(2);
  const [soundBanner, setSoundBanner] = useState<Banner>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await fetch("/local/notify/config", { cache: "no-store" });
        if (r.ok) {
          const d = (await r.json()) as {
            enabled: boolean;
            multicast_group: string;
            multicast_port: number;
          };
          if (active) {
            setEnabled(d.enabled);
            setGroup(d.multicast_group);
            setPort(String(d.multicast_port));
          }
        }
      } catch {
        /* keep defaults */
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function saveConfig() {
    setSavingCfg(true);
    setCfgBanner(null);
    try {
      const r = await fetch("/local/notify/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          multicast_group: group.trim(),
          multicast_port: Number(port),
        }),
      });
      const b = (await r.json().catch(() => null)) as { detail?: string } | null;
      setCfgBanner(
        r.ok
          ? { kind: "success", text: "Saved." }
          : { kind: "error", text: b?.detail ?? `Failed (HTTP ${r.status}).` }
      );
    } catch {
      setCfgBanner({ kind: "error", text: "Could not reach the API." });
    } finally {
      setSavingCfg(false);
    }
  }

  async function sendTest(
    path: string,
    payload: Record<string, unknown>,
    setBanner: (b: Banner) => void
  ) {
    setBanner(null);
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const b = (await r.json().catch(() => null)) as
        | { ok?: boolean; sent?: unknown; detail?: string }
        | null;
      if (!r.ok) {
        setBanner({ kind: "error", text: b?.detail ?? `Failed (HTTP ${r.status}).` });
        return;
      }
      setBanner({
        kind: b?.ok ? "success" : "error",
        text: b?.ok
          ? `Sent: ${JSON.stringify(b.sent)}`
          : "Send failed (check the multicast group/port and network).",
      });
    } catch {
      setBanner({ kind: "error", text: "Could not reach the API." });
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-4 text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Stack-light &amp; buzzer notifications are sent as JSON over UDP multicast.
        </p>
      </div>

      {/* Multicast target */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Multicast target</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Group (IPv4 multicast)
            </span>
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Port
            </span>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none"
            />
          </label>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable event-driven notifications (bad-tag / status). Test buttons always send.
        </label>
        {cfgBanner && <BannerLine b={cfgBanner} />}
        <div className="mt-4">
          <button
            type="button"
            onClick={saveConfig}
            disabled={savingCfg}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {savingCfg ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      {/* Test light */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Test light</h2>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Select label="Pattern" value={pattern} onChange={(v) => setPattern(v as typeof pattern)} options={PATTERNS} />
          <Select label="Color" value={color} onChange={(v) => setColor(v as typeof color)} options={COLORS} />
          <Num label="Brightness (0–100)" value={brightness} onChange={setBrightness} min={0} max={100} />
          <Num label="Duration (ms)" value={lightDuration} onChange={setLightDuration} min={0} max={600000} />
          <Num label="Repeat (1–5)" value={lightRepeat} onChange={setLightRepeat} min={1} max={5} />
        </div>
        {lightBanner && <BannerLine b={lightBanner} />}
        <div className="mt-4">
          <button
            type="button"
            onClick={() =>
              sendTest(
                "/local/notify/test/light",
                { pattern, color, brightness, duration: lightDuration, repeat_count: lightRepeat },
                setLightBanner
              )
            }
            className="rounded-md bg-zinc-800 px-4 py-1.5 text-sm font-semibold text-white hover:bg-zinc-900"
          >
            Send test light
          </button>
        </div>
      </section>

      {/* Test sound */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Test sound</h2>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Sound</span>
            <input
              value={sound}
              onChange={(e) => setSound(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
            />
          </label>
          <Num label="Volume (0–100)" value={volume} onChange={setVolume} min={0} max={100} />
          <Num label="Duration (ms)" value={soundDuration} onChange={setSoundDuration} min={0} max={600000} />
          <Num label="Repeat (1–5)" value={soundRepeat} onChange={setSoundRepeat} min={1} max={5} />
        </div>
        {soundBanner && <BannerLine b={soundBanner} />}
        <div className="mt-4">
          <button
            type="button"
            onClick={() =>
              sendTest(
                "/local/notify/test/sound",
                { sound: sound.trim(), volume, duration: soundDuration, repeat_count: soundRepeat },
                setSoundBanner
              )
            }
            className="rounded-md bg-zinc-800 px-4 py-1.5 text-sm font-semibold text-white hover:bg-zinc-900"
          >
            Send test sound
          </button>
        </div>
      </section>
    </div>
  );
}

function BannerLine({ b }: { b: NonNullable<Banner> }) {
  return (
    <p
      className={
        "mt-4 break-all rounded-md border px-3 py-2 text-xs " +
        (b.kind === "success"
          ? "border-green-200 bg-green-50 text-green-700"
          : "border-red-200 bg-red-50 text-red-700")
      }
    >
      {b.text}
    </p>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Num({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
      />
    </label>
  );
}
