"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { KioskDropdown, type DropdownOption } from "@/components/KioskDropdown";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import type { StepProps } from "./InitialSetupWizard";

type Move = {
  id: number;
  name: string | null;
  status_name: string | null;
  status_color: string | null;
};

export function StepSelectMove({ state, update }: StepProps) {
  const [moves, setMoves] = useState<Move[]>([]);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);

  async function loadCloud() {
    try {
      const r = await fetch("/local/portal-data/cloud-sync", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as {
          moves?: Move[];
          last_synced_at?: string | null;
          last_error?: string | null;
        };
        setMoves(d.moves ?? []);
        setLastSynced(d.last_synced_at ?? null);
        setLoadErr(d.last_error ?? null);
      }
    } catch {
      /* keep last */
    }
  }

  // Initial load + preselect any existing active move.
  useEffect(() => {
    loadCloud().finally(() => setLoading(false));
    (async () => {
      try {
        const r = await fetch("/local/active-selection", { cache: "no-store" });
        if (r.ok) {
          const d = (await r.json()) as { type?: string; id?: number; name?: string | null };
          if (d?.type === "move" && typeof d.id === "number") {
            update({ moveId: d.id, moveName: d.name ?? null });
          }
        }
      } catch {
        /* ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sync() {
    setSyncing(true);
    try {
      await fetch("/local/portal-data/refresh", { method: "POST" });
      await loadCloud();
    } catch {
      /* keep last */
    } finally {
      setSyncing(false);
    }
  }

  async function pick(id: number) {
    const m = moves.find((x) => x.id === id);
    update({ moveId: id, moveName: m?.name ?? null });
    try {
      await fetch("/local/active-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "move", id }),
      });
    } catch {
      /* selection still reflected in UI; persistence retried on next pick */
    }
  }

  const options: DropdownOption[] = moves.map((m) => ({
    id: m.id,
    label: m.name ?? `Move #${m.id}`,
    sublabel: m.status_name ?? undefined,
    color: m.status_color ?? undefined,
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <LoadingOverlay
        show={loading || syncing}
        label={syncing ? "Syncing moves…" : "Loading moves…"}
      />
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Active Move
        </p>
        <div className="mt-2">
          <KioskDropdown
            value={state.moveId}
            options={options}
            placeholder="Select a move…"
            onChange={pick}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={sync}
          disabled={syncing}
          className="flex h-10 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 text-sm font-medium text-zinc-200 disabled:opacity-50"
        >
          <RefreshCw className={"h-4 w-4 " + (syncing ? "animate-spin" : "")} />
          {syncing ? "Syncing…" : "Sync moves"}
        </button>
        <span className="text-xs text-zinc-500">
          {loadErr
            ? `Sync error: ${loadErr}`
            : lastSynced
              ? `Last synced ${new Date(lastSynced).toLocaleString()} · ${moves.length} moves`
              : `${moves.length} moves`}
        </span>
      </div>
    </div>
  );
}
