"use client";

import { useEffect, useState } from "react";

// /config → Settings → Audio. Map the three event categories (Error / Alert /
// Info) to sounds played on the Pi speaker, set the volume, preview each, and
// drag-and-drop new sound files. Backed by /local/audio/{config,test,upload}.

type Banner = { kind: "success" | "error"; text: string } | null;
type Cat = "error" | "alert" | "info";
type CatRow = { id: Cat; label: string; sound_file: string; enabled: boolean; default: string };

const CAT_HELP: Record<Cat, string> = {
  error: "Critical events — e.g. a tag scanned that's not in the selected move.",
  alert: "Warnings.",
  info: "Informational events (e.g. sync). Off by default to avoid noise.",
};

export default function AudioPage() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<CatRow[]>([]);
  const [sounds, setSounds] = useState<string[]>([]);
  const [allowed, setAllowed] = useState<string[]>([".wav"]);
  const [volume, setVolume] = useState(80);
  const [volumeMax, setVolumeMax] = useState(400);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  type Cfg = {
    categories: CatRow[];
    volume_pct: number;
    volume_max?: number;
    sounds: string[];
    allowed_ext?: string[];
  };

  function applyCfg(d: Cfg) {
    setRows(d.categories ?? []);
    setSounds(d.sounds ?? []);
    setVolume(d.volume_pct ?? 80);
    if (d.volume_max) setVolumeMax(d.volume_max);
    if (d.allowed_ext) setAllowed(d.allowed_ext);
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await fetch("/local/audio/config", { cache: "no-store" });
        if (r.ok && active) applyCfg((await r.json()) as Cfg);
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

  function setRow(id: Cat, patch: Partial<CatRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function save() {
    setSaving(true);
    setBanner(null);
    try {
      const byId = (id: Cat) => rows.find((r) => r.id === id)!;
      const payload = {
        error: { sound_file: byId("error").sound_file, enabled: byId("error").enabled },
        alert: { sound_file: byId("alert").sound_file, enabled: byId("alert").enabled },
        info: { sound_file: byId("info").sound_file, enabled: byId("info").enabled },
        volume_pct: Number(volume),
      };
      const r = await fetch("/local/audio/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const b = (await r.json().catch(() => null)) as { detail?: string } | null;
      setBanner(r.ok ? { kind: "success", text: "Saved." } : { kind: "error", text: b?.detail ?? `Failed (HTTP ${r.status}).` });
    } catch {
      setBanner({ kind: "error", text: "Could not reach the API." });
    } finally {
      setSaving(false);
    }
  }

  async function test(category: Cat) {
    try {
      await fetch("/local/audio/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      });
    } catch {
      setBanner({ kind: "error", text: "Could not reach the API." });
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    setBanner(null);
    try {
      for (const file of list) {
        const fd = new FormData();
        fd.append("file", file);
        const r = await fetch("/local/audio/upload", { method: "POST", body: fd });
        const b = (await r.json().catch(() => null)) as { detail?: string; sounds?: string[] } | null;
        if (!r.ok) {
          setBanner({ kind: "error", text: `${file.name}: ${b?.detail ?? `failed (HTTP ${r.status})`}` });
          continue;
        }
        if (b?.sounds) setSounds(b.sounds);
        setBanner({ kind: "success", text: `Uploaded ${file.name}.` });
      }
    } catch {
      setBanner({ kind: "error", text: "Upload failed — could not reach the API." });
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Audio</h1>
        <p className="mt-4 text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audio</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Sounds played on the Pi speaker for events. Events are mapped by severity:
          critical → <b>Error</b>, warning → <b>Alert</b>, info → <b>Info</b>.
        </p>
      </div>

      {/* Category → sound mappings */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Sound mapping</h2>
        <div className="mt-4 space-y-4">
          {rows.map((row) => (
            <div key={row.id} className="grid grid-cols-1 items-end gap-3 border-t border-zinc-100 pt-4 first:border-t-0 first:pt-0 sm:grid-cols-[1fr_auto_auto]">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{row.label}</span>
                <span className="block text-[11px] text-zinc-400">{CAT_HELP[row.id]}</span>
                <select
                  value={row.sound_file}
                  onChange={(e) => setRow(row.id, { sound_file: e.target.value })}
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
                >
                  {sounds.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 pb-1.5 text-sm text-zinc-700">
                <input type="checkbox" checked={row.enabled} onChange={(e) => setRow(row.id, { enabled: e.target.checked })} />
                Play
              </label>
              <button
                type="button"
                onClick={() => test(row.id)}
                className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-900"
              >
                Test
              </button>
            </div>
          ))}
        </div>

        <label className="mt-5 block max-w-xs">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Volume ({volume}%){volume > 100 && <span className="ml-1 font-normal text-amber-600">overdrive</span>}
          </span>
          <input
            type="range"
            min={0}
            max={volumeMax}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="mt-1 w-full"
          />
          <span className="block text-[11px] text-zinc-400">
            Above 100% amplifies in software (louder, but may distort) — up to {volumeMax}%.
          </span>
        </label>

        {banner && (
          <p
            className={
              "mt-4 break-all rounded-md border px-3 py-2 text-xs " +
              (banner.kind === "success"
                ? "border-green-200 bg-green-50 text-green-700"
                : "border-red-200 bg-red-50 text-red-700")
            }
          >
            {banner.text}
          </p>
        )}

        <div className="mt-4">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      {/* Upload */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Add a sound</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Drag a file here or click to browse. Accepted: {allowed.join(", ")} (mp3/ogg are
          converted to WAV). Uploaded sounds appear in the dropdowns above.
        </p>
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
          }}
          className={
            "mt-3 flex h-28 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed text-sm transition-colors " +
            (dragOver ? "border-blue-400 bg-blue-50 text-blue-600" : "border-zinc-300 text-zinc-500 hover:border-zinc-400")
          }
        >
          <input
            type="file"
            accept={allowed.join(",")}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {uploading ? "Uploading…" : dragOver ? "Drop to upload" : "Drag & drop a sound, or click to browse"}
        </label>
      </section>
    </div>
  );
}
