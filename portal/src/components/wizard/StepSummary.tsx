"use client";

import { useEffect, useRef, useState } from "react";
import { Check, X, Circle, Radio, Loader2, Home } from "lucide-react";
import type { WizardState } from "./InitialSetupWizard";

type RowStatus = "ok" | "pending" | "error";
// idle → working → (commit_error | start_error | started). Both action buttons
// save the settings; "Save & Start" then also starts the reader's radio.
type Phase = "idle" | "working" | "commit_error" | "start_error" | "started";
type Mode = "with_radio" | "no_radio";

const HOME_DELAY_MS = 2500;

// Step 4: confirm, then commit + (optionally) start the RFID radio. The save
// happens here (not on step 3's Next), so the operator chooses how to finish:
// save and start reading, or save and leave the radio stopped.
export function StepSummary({
  state,
  onHome,
}: {
  state: WizardState;
  onHome: () => void;
}) {
  const [syncOk, setSyncOk] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<Mode>("with_radio");
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  // Move row turns green only when the cloud sync that backs it succeeded.
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

  // Push the site + scan type to the cloud as soon as Step 4 loads — so the
  // Scan Type row confirms on load (like Move/Site) instead of waiting for a
  // Save button. The buttons below then just start (or skip) the RFID radio.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusyLabel("Confirming scan type…");
      setPhase("working");
      const ok = await commit();
      if (cancelled || !mounted.current) return;
      setPhase(ok ? "idle" : "commit_error");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a successful start, head back to the home screen shortly.
  useEffect(() => {
    if (phase !== "started") return;
    const t = setTimeout(onHome, HOME_DELAY_MS);
    return () => clearTimeout(t);
  }, [phase, onHome]);

  async function commit(): Promise<boolean> {
    if (!state.readerName || state.siteId == null || state.scanTypeId == null) {
      setError("Missing reader, site, or scan type.");
      return false;
    }
    try {
      const r = await fetch("/local/setup/reader-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reader_name: state.readerName,
          site_id: state.siteId,
          scan_type_id: state.scanTypeId,
          site_name: state.siteName,
          scan_type_name: state.scanTypeName,
        }),
      });
      if (r.ok) {
        if (mounted.current) setCommitted(true);
        return true;
      }
      const b = (await r.json().catch(() => null)) as { detail?: string } | null;
      setError(b?.detail ?? "Failed to save reader settings.");
      return false;
    } catch {
      setError("Failed to save reader settings.");
      return false;
    }
  }

  async function startRadio(): Promise<boolean> {
    try {
      // The reader we just saved is now the active reader; get its id.
      const ar = await fetch("/local/rfid/active-reader", { cache: "no-store" });
      const ad = (await ar.json().catch(() => null)) as
        | { configured?: boolean; reader_id?: number | null }
        | null;
      if (!ar.ok || !ad?.configured || ad.reader_id == null) {
        setError("No active reader to start.");
        return false;
      }
      const sr = await fetch(`/local/rfid/readers/${ad.reader_id}/start`, { method: "POST" });
      if (sr.ok) return true;
      const sb = (await sr.json().catch(() => null)) as { detail?: string } | null;
      setError(sb?.detail ?? "Failed to start the RFID radio.");
      return false;
    } catch {
      setError("Failed to start the RFID radio.");
      return false;
    }
  }

  async function saveAndStart() {
    setMode("with_radio");
    setError(null);
    // Settings were already committed on load; only re-commit if that failed.
    if (!committed) {
      setBusyLabel("Saving settings…");
      setPhase("working");
      if (!(await commit())) {
        if (mounted.current) setPhase("commit_error");
        return;
      }
      if (!mounted.current) return;
    }
    setBusyLabel("Starting RFID radio…");
    setPhase("working");
    const ok = await startRadio();
    if (!mounted.current) return;
    setPhase(ok ? "started" : "start_error");
  }

  async function saveOnly() {
    setMode("no_radio");
    setError(null);
    if (!committed) {
      setBusyLabel("Saving settings…");
      setPhase("working");
      if (!(await commit())) {
        if (mounted.current) setPhase("commit_error");
        return;
      }
      if (!mounted.current) return;
    }
    onHome();
  }

  function retryCommit() {
    if (mode === "with_radio") saveAndStart();
    else saveOnly();
  }

  async function retryStart() {
    setError(null);
    setBusyLabel("Starting RFID radio…");
    setPhase("working");
    const ok = await startRadio();
    if (!mounted.current) return;
    setPhase(ok ? "started" : "start_error");
  }

  const moveStatus: RowStatus = state.moveId != null && syncOk ? "ok" : "pending";
  const siteStatus: RowStatus = state.siteId != null ? "ok" : "pending";
  const scanStatus: RowStatus = committed ? "ok" : phase === "commit_error" ? "error" : "pending";

  const working = phase === "working";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
        Confirm your setup
      </p>
      <SummaryRow label="Move" value={state.moveName ?? "—"} status={moveStatus} />
      <SummaryRow label="Site" value={state.siteName ?? "—"} status={siteStatus} />
      <SummaryRow label="Scan Type" value={state.scanTypeName ?? "—"} status={scanStatus} />

      {phase === "started" ? (
        <div className="flex items-center gap-2 rounded-lg border border-green-700 bg-green-950/40 px-3 py-2 text-sm text-green-300">
          <Check className="h-4 w-4 flex-none" />
          Settings saved and RFID radio started — now reading. Returning home…
        </div>
      ) : phase === "start_error" ? (
        <div className="rounded-lg border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          Settings saved, but the radio didn’t start — {error}
        </div>
      ) : phase === "commit_error" ? (
        <div className="rounded-lg border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      ) : working ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> {busyLabel}
        </div>
      ) : (
        <p className="text-xs text-zinc-500">Choose how to finish setup.</p>
      )}

      <div className="mt-auto flex flex-col gap-2 pt-2">
        {phase === "idle" || phase === "working" ? (
          <>
            <button
              type="button"
              onClick={saveAndStart}
              disabled={working}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-green-600 text-base font-semibold text-white disabled:opacity-50"
            >
              <Radio className="h-5 w-5" /> Save Settings &amp; Start RFID Radio
            </button>
            <button
              type="button"
              onClick={saveOnly}
              disabled={working}
              className="flex h-11 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800 text-sm font-semibold text-zinc-200 disabled:opacity-50"
            >
              Save without starting radio
            </button>
          </>
        ) : phase === "commit_error" ? (
          <button
            type="button"
            onClick={retryCommit}
            className="flex h-12 items-center justify-center rounded-xl bg-blue-600 text-base font-semibold text-white"
          >
            Retry
          </button>
        ) : phase === "start_error" ? (
          <>
            <button
              type="button"
              onClick={retryStart}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-green-600 text-base font-semibold text-white"
            >
              <Radio className="h-5 w-5" /> Retry Start
            </button>
            <button
              type="button"
              onClick={onHome}
              className="flex h-11 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800 text-sm font-semibold text-zinc-200"
            >
              Finish anyway
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onHome}
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-green-600 text-base font-semibold text-white"
          >
            <Home className="h-5 w-5" /> Go to Home now
          </button>
        )}
      </div>
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
