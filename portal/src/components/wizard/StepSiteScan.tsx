"use client";

import { useEffect, useState } from "react";
import { KioskDropdown, type DropdownOption } from "@/components/KioskDropdown";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import type { StepProps } from "./InitialSetupWizard";

type Site = { id: number; name: string | null };
type ScanType = { id: number; name: string; color?: string | null };

export function StepSiteScan({ state, update }: StepProps) {
  const [source, setSource] = useState<Site | null>(null);
  const [destination, setDestination] = useState<Site | null>(null);
  const [scanTypes, setScanTypes] = useState<ScanType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [locRes, stRes] = await Promise.all([
          fetch(`/local/setup/move-locations?move_id=${state.moveId}`, { cache: "no-store" }),
          fetch("/local/setup/scan-types", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (locRes.ok) {
          const d = (await locRes.json()) as { source?: Site | null; destination?: Site | null };
          setSource(d.source ?? null);
          setDestination(d.destination ?? null);
        } else {
          const b = (await locRes.json().catch(() => null)) as { detail?: string } | null;
          throw new Error(b?.detail ?? "Could not load move locations.");
        }
        if (stRes.ok) {
          const d = (await stRes.json()) as { scan_types?: ScanType[] };
          setScanTypes(d.scan_types ?? []);
        } else {
          const b = (await stRes.json().catch(() => null)) as { detail?: string } | null;
          throw new Error(b?.detail ?? "Could not load scan types.");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load from portal.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Natural sort (RFID 2 before RFID 10), mirroring the portal popup's
  // localeCompare({numeric:true}) — the cloud endpoint returns plain name order.
  const scanOptions: DropdownOption[] = scanTypes
    .slice()
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    )
    .map((s) => ({
      id: s.id,
      label: s.name,
      color: s.color ?? undefined,
    }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
      <LoadingOverlay show={loading} label="Loading move sites & scan types…" />
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!loading && !error && (
        <>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              This reader represents
            </p>
            <div className="mt-2 flex gap-4">
              <SiteCard
                role="Source"
                site={source}
                selected={source != null && state.siteId === source.id}
                onClick={() => source && update({ siteId: source.id, siteName: source.name ?? null })}
              />
              <SiteCard
                role="Destination"
                site={destination}
                selected={destination != null && state.siteId === destination.id}
                onClick={() => destination && update({ siteId: destination.id, siteName: destination.name ?? null })}
              />
            </div>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Scan Type
            </p>
            <div className="mt-2">
              <KioskDropdown
                value={state.scanTypeId}
                options={scanOptions}
                placeholder="Select a scan type…"
                onChange={(id) => {
                  const st = scanTypes.find((s) => s.id === id);
                  update({ scanTypeId: id, scanTypeName: st?.name ?? null });
                }}
              />
            </div>
          </div>
        </>
      )}
      <p className="mt-auto text-xs text-zinc-500">
        Reader <span className="text-zinc-300">{state.readerName ?? "—"}</span> · Move{" "}
        <span className="text-zinc-300">{state.moveName ?? "—"}</span>
      </p>
    </div>
  );
}

function SiteCard({
  role,
  site,
  selected,
  onClick,
}: {
  role: string;
  site: Site | null;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!site}
      className={
        "flex-1 rounded-2xl border p-4 text-left " +
        (selected ? "border-green-600 bg-green-950/40 " : "border-zinc-800 bg-zinc-900 ") +
        (!site ? "opacity-50" : "")
      }
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
        {role}
      </div>
      <div className="mt-1.5 text-lg text-zinc-100">{site?.name ?? "—"}</div>
    </button>
  );
}
