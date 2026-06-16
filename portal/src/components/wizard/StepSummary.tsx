"use client";

import { useEffect, useState } from "react";
import { Check, X, Circle } from "lucide-react";
import type { WizardState } from "./InitialSetupWizard";

type RowStatus = "ok" | "pending" | "error";

// Step 4: confirm + commit summary. Move is green when a sync succeeded and a
// move is chosen; Site is green when selected; Scan Type is green once the
// portal commit (POST reader-settings) returned 200, red on failure.
export function StepSummary({
  state,
  committed,
  commitError,
}: {
  state: WizardState;
  committed: boolean;
  commitError: string | null;
}) {
  const [syncOk, setSyncOk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/local/portal-data/cloud-sync", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as {
            last_error?: string | null;
            last_synced_at?: string | null;
          };
          setSyncOk(!d.last_error && !!d.last_synced_at);
        }
      } catch {
        /* leave syncOk false */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const moveStatus: RowStatus = state.moveId != null && syncOk ? "ok" : "pending";
  const siteStatus: RowStatus = state.siteId != null ? "ok" : "pending";
  const scanStatus: RowStatus = committed ? "ok" : commitError ? "error" : "pending";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
        Confirm your setup
      </p>
      <SummaryRow label="Move" value={state.moveName ?? "—"} status={moveStatus} />
      <SummaryRow label="Site" value={state.siteName ?? "—"} status={siteStatus} />
      <SummaryRow label="Scan Type" value={state.scanTypeName ?? "—"} status={scanStatus} />
      <p className="mt-1 text-xs text-zinc-500">
        {committed
          ? "Settings applied to the portal."
          : commitError
            ? `Apply failed — ${commitError}`
            : "Review your choices, then tap Confirm & Apply to write them to the portal."}
      </p>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: RowStatus;
}) {
  const ring =
    status === "ok"
      ? "border-green-600 bg-green-950/30"
      : status === "error"
        ? "border-red-600 bg-red-950/30"
        : "border-zinc-800 bg-zinc-900";
  const valueTone =
    status === "ok"
      ? "text-green-400"
      : status === "error"
        ? "text-red-400"
        : "text-zinc-100";
  return (
    <div className={"flex items-center gap-3 rounded-xl border px-4 py-3 " + ring}>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
          {label}
        </div>
        <div className={"truncate text-lg " + valueTone}>{value}</div>
      </div>
      <div className="ml-auto">
        {status === "ok" && <Check className="h-6 w-6 text-green-400" aria-hidden />}
        {status === "error" && <X className="h-6 w-6 text-red-400" aria-hidden />}
        {status === "pending" && <Circle className="h-5 w-5 text-zinc-600" aria-hidden />}
      </div>
    </div>
  );
}
