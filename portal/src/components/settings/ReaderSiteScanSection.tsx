// portal/src/components/settings/ReaderSiteScanSection.tsx
"use client";

import { useEffect, useState } from "react";

type Site = { id: number; name: string | null };
type ScanType = { id: number; name: string; color?: string | null };
type Selection = { type?: string | null; id?: number | null; name?: string | null };
type Current = {
  reader_name: string | null;
  site_id: number | null;
  site_name: string | null;
  scan_type_id: number | null;
  scan_type_name: string | null;
};

export function ReaderSiteScanSection() {
  const [readerName, setReaderName] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [source, setSource] = useState<Site | null>(null);
  const [destination, setDestination] = useState<Site | null>(null);
  const [scanTypes, setScanTypes] = useState<ScanType[]>([]);
  const [siteId, setSiteId] = useState<string>("");
  const [scanTypeId, setScanTypeId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [curR, selR, arR, stR] = await Promise.all([
          fetch("/local/setup/reader-settings", { cache: "no-store" }),
          fetch("/local/active-selection", { cache: "no-store" }),
          fetch("/local/rfid/active-reader", { cache: "no-store" }),
          fetch("/local/setup/scan-types", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        const cur = (await curR.json().catch(() => null)) as Current | null;
        const sel = (await selR.json().catch(() => null)) as Selection | null;
        const ar = (await arR.json().catch(() => null)) as { configured?: boolean; name?: string } | null;
        const st = (await stR.json().catch(() => null)) as { scan_types?: ScanType[] } | null;
        setSelection(sel);
        setReaderName(cur?.reader_name ?? (ar?.configured ? ar?.name ?? null : null));
        setScanTypes(st?.scan_types ?? []);
        if (sel?.type === "move" && sel.id != null) {
          const locR = await fetch(`/local/setup/move-locations?move_id=${sel.id}`, { cache: "no-store" });
          const loc = (await locR.json().catch(() => null)) as { source?: Site | null; destination?: Site | null } | null;
          if (!cancelled) {
            setSource(loc?.source ?? null);
            setDestination(loc?.destination ?? null);
          }
        }
        if (cur?.site_id != null) setSiteId(String(cur.site_id));
        if (cur?.scan_type_id != null) setScanTypeId(String(cur.scan_type_id));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sites = [source, destination].filter((s): s is Site => s != null);
  const hasMove = selection?.type === "move" && selection.id != null;
  const siteValid = siteId === "" || sites.some((s) => String(s.id) === siteId);

  async function save() {
    if (!readerName) return;
    const site = sites.find((s) => String(s.id) === siteId) ?? null;
    const st = scanTypes.find((s) => String(s.id) === scanTypeId) ?? null;
    if (site == null || st == null) {
      setBanner({ kind: "error", text: "Pick a site and a scan type." });
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch("/local/setup/reader-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reader_name: readerName,
          site_id: site.id,
          site_name: site.name ?? null,
          scan_type_id: st.id,
          scan_type_name: st.name,
        }),
      });
      if (res.ok) {
        setBanner({ kind: "success", text: "Saved." });
      } else {
        const b = (await res.json().catch(() => null)) as { detail?: string } | null;
        setBanner({ kind: "error", text: b?.detail ?? "Save failed." });
      }
    } catch {
      setBanner({ kind: "error", text: "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold">Site &amp; Scan Type</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Bind the active reader to a move site and scan type without re-running setup.
      </p>
      {banner && (
        <div
          className={
            "mt-3 rounded-md px-3 py-2 text-sm " +
            (banner.kind === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700")
          }
        >
          {banner.text}
        </div>
      )}
      {!readerName ? (
        <p className="mt-4 text-sm text-amber-700">Add and select a reader first.</p>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-zinc-600">
            Reader: <span className="font-medium">{readerName}</span>
          </p>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Site (source / destination)
            </label>
            {hasMove ? (
              <select
                value={siteValid ? siteId : ""}
                onChange={(e) => setSiteId(e.target.value)}
                disabled={loading}
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">— Select —</option>
                {source && <option value={String(source.id)}>Source — {source.name ?? source.id}</option>}
                {destination && (
                  <option value={String(destination.id)}>Destination — {destination.name ?? destination.id}</option>
                )}
              </select>
            ) : (
              <p className="mt-1 text-sm text-amber-700">Select a move on the Config home page first.</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Scan type
            </label>
            <select
              value={scanTypeId}
              onChange={(e) => setScanTypeId(e.target.value)}
              disabled={loading}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="">— Select —</option>
              {scanTypes
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
                .map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={save}
              disabled={saving || loading}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:bg-zinc-400"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
