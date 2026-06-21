"use client";

import { useEffect, useState } from "react";

// /config → Settings → Notifications. Configure the multicast target the stack
// lights listen on, and send test light/sound messages. Backed by
// /local/notify/{config,test/light,test/sound}.

type Banner = { kind: "success" | "error"; text: string } | null;
type CatalogEntry = { id: string; label: string; group: "metrics" | "section" };

const PATTERNS = ["solid", "flash", "pulse"] as const;
const COLORS = ["red", "green", "yellow", "blue"] as const;

export default function NotificationsPage() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [group, setGroup] = useState("239.10.10.10");
  const [port, setPort] = useState("5005");
  const [readerLight, setReaderLight] = useState(true);
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgBanner, setCfgBanner] = useState<Banner>(null);

  // Status broadcast (snapshot to remote displays)
  const [statusEnabled, setStatusEnabled] = useState(true);
  const [statusGroup, setStatusGroup] = useState("239.10.10.11");
  const [statusPort, setStatusPort] = useState("5006");
  const [savingStatus, setSavingStatus] = useState(false);
  const [statusBanner, setStatusBanner] = useState<Banner>(null);
  // What-to-send tick boxes: catalog from the API + the set of excluded ids.
  const [statusCatalog, setStatusCatalog] = useState<CatalogEntry[]>([]);
  const [statusExcluded, setStatusExcluded] = useState<Set<string>>(new Set());

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
            reader_light_enabled?: boolean;
          };
          if (active) {
            setEnabled(d.enabled);
            setGroup(d.multicast_group);
            setPort(String(d.multicast_port));
            setReaderLight(d.reader_light_enabled ?? true);
          }
        }
        const sr = await fetch("/local/notify/status-config", { cache: "no-store" });
        if (sr.ok) {
          const sd = (await sr.json()) as {
            enabled: boolean;
            multicast_group: string;
            multicast_port: number;
            catalog?: CatalogEntry[];
            excluded?: string[];
          };
          if (active) {
            setStatusEnabled(sd.enabled);
            setStatusGroup(sd.multicast_group);
            setStatusPort(String(sd.multicast_port));
            setStatusCatalog(sd.catalog ?? []);
            setStatusExcluded(new Set(sd.excluded ?? []));
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
          reader_light_enabled: readerLight,
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

  async function saveStatus() {
    setSavingStatus(true);
    setStatusBanner(null);
    try {
      const r = await fetch("/local/notify/status-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: statusEnabled,
          multicast_group: statusGroup.trim(),
          multicast_port: Number(statusPort),
          excluded: Array.from(statusExcluded),
        }),
      });
      const b = (await r.json().catch(() => null)) as { detail?: string } | null;
      setStatusBanner(
        r.ok
          ? { kind: "success", text: "Saved." }
          : { kind: "error", text: b?.detail ?? `Failed (HTTP ${r.status}).` }
      );
    } catch {
      setStatusBanner({ kind: "error", text: "Could not reach the API." });
    } finally {
      setSavingStatus(false);
    }
  }

  function toggleSend(id: string, send: boolean) {
    setStatusExcluded((prev) => {
      const next = new Set(prev);
      if (send) next.delete(id);
      else next.add(id);
      return next;
    });
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
        <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={readerLight} onChange={(e) => setReaderLight(e.target.checked)} />
          Mirror the RFID reader traffic light to the stack light (solid red/yellow/blue/green).
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

      {/* Status broadcast */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Status broadcast</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Multicasts a status snapshot (metrics, reader state, recent activity &amp;
          events) to remote status displays every 5s and on change. Separate
          group/port from the stack lights.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Group (IPv4 multicast)
            </span>
            <input
              value={statusGroup}
              onChange={(e) => setStatusGroup(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Port
            </span>
            <input
              type="number"
              value={statusPort}
              onChange={(e) => setStatusPort(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none"
            />
          </label>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={statusEnabled}
            onChange={(e) => setStatusEnabled(e.target.checked)}
          />
          Broadcast status snapshots to remote displays.
        </label>

        {/* What to send — tick boxes (all on by default) */}
        {statusCatalog.length > 0 && (
          <div className="mt-5 border-t border-zinc-100 pt-4">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              What to send
            </span>
            <p className="mt-1 text-xs text-zinc-500">
              All on by default. Unchecked items are omitted from the snapshot (and not
              computed), so remote displays won&apos;t show them.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {statusCatalog.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="checkbox"
                    checked={!statusExcluded.has(c.id)}
                    onChange={(e) => toggleSend(c.id, e.target.checked)}
                  />
                  {c.label}
                  {c.group === "section" && (
                    <span className="text-xs text-zinc-400">(section)</span>
                  )}
                </label>
              ))}
            </div>
          </div>
        )}

        {statusBanner && <BannerLine b={statusBanner} />}
        <div className="mt-4">
          <button
            type="button"
            onClick={saveStatus}
            disabled={savingStatus}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {savingStatus ? "Saving…" : "Save"}
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
