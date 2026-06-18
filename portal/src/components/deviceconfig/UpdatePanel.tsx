"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RefreshCw, CheckCircle2, Loader2 } from "lucide-react";
import { PanelShell, Banner } from "./panelChrome";

// Config → Update. Shows the installed git revision vs. the latest on the
// tracked branch, and (when behind) triggers the privileged updater, which
// runs deploy.sh and reboots. While a run is in flight we poll for state and
// stream the updater's log tail. Backed by /local/update/{status,start}.

type Status = {
  branch: string;
  current_short: string;
  latest_short: string | null;
  behind: number;
  update_available: boolean;
  fetch_ok: boolean;
  state: "idle" | "running" | "success" | "failed";
  log_tail: string;
};

type Phase = "loading" | "idle" | "updating";

const POLL_MS = 1500;

export function UpdatePanel({ onBack }: { onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const fetchStatus = useCallback(async (): Promise<Status | null> => {
    const r = await fetch("/local/update/status", { cache: "no-store" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    return (await r.json()) as Status;
  }, []);

  // Initial check on open. If a run is already in flight (e.g. the panel was
  // reopened mid-update), drop straight into the streaming view.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchStatus();
        if (cancelled || !s) return;
        setStatus(s);
        setPhase(s.state === "running" ? "updating" : "idle");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "failed to check for updates");
          setPhase("idle");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  // Poll while updating; stop once the run reaches a terminal state. Once the
  // device reboots, fetches start failing — that's expected, so we swallow it.
  useEffect(() => {
    if (phase !== "updating") return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const s = await fetchStatus();
        if (cancelled || !s) return;
        setStatus(s);
        if (s.state === "success" || s.state === "failed") clearInterval(id);
      } catch {
        /* reboot / API restarting — keep showing the last state */
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, fetchStatus]);

  // Keep the streamed log pinned to the bottom.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log_tail]);

  const check = async () => {
    setError(null);
    setPhase("loading");
    try {
      const s = await fetchStatus();
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to check for updates");
    }
    setPhase("idle");
  };

  const startUpdate = async () => {
    setError(null);
    try {
      const r = await fetch("/local/update/start", { method: "POST" });
      if (!r.ok) throw new Error(`start ${r.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start update");
      return;
    }
    setStatus((s) => (s ? { ...s, state: "running", log_tail: "" } : s));
    setPhase("updating");
  };

  // ---- streaming view ----
  if (phase === "updating" && status) {
    const done = status.state === "success";
    const failed = status.state === "failed";
    return (
      <PanelShell title="Update" onBack={onBack}>
        <div className="flex h-full flex-col gap-3">
          <div className="flex items-center gap-3">
            {done ? (
              <CheckCircle2 className="h-6 w-6 text-green-400" aria-hidden />
            ) : (
              <Loader2 className={`h-6 w-6 text-blue-400 ${failed ? "" : "animate-spin"}`} aria-hidden />
            )}
            <p className="text-lg font-semibold text-zinc-100">
              {done ? "Update complete — rebooting…" : failed ? "Update failed" : "Updating…"}
            </p>
          </div>
          {done && (
            <Banner kind="success" text="The device will restart and come back on the new version shortly." />
          )}
          {failed && <Banner kind="error" text="The update did not finish. The device is still running the previous version." />}
          <pre
            ref={logRef}
            className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-black/50 p-3 font-mono text-xs leading-relaxed text-zinc-300"
          >
            {status.log_tail || "Starting…"}
          </pre>
          {failed && (
            <button
              type="button"
              onClick={check}
              className="h-11 self-start rounded-lg bg-zinc-800 px-6 text-sm font-semibold text-zinc-100"
            >
              Back to check
            </button>
          )}
        </div>
      </PanelShell>
    );
  }

  // ---- check / idle view ----
  const upToDate = status && !status.update_available;
  return (
    <PanelShell title="Update" onBack={onBack}>
      <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
        {phase === "loading" ? (
          <>
            <Loader2 className="h-14 w-14 animate-spin text-zinc-500" strokeWidth={1.4} aria-hidden />
            <p className="text-zinc-400">Checking for updates…</p>
          </>
        ) : (
          <>
            {upToDate ? (
              <CheckCircle2 className="h-16 w-16 text-green-500" strokeWidth={1.4} aria-hidden />
            ) : (
              <Download className="h-16 w-16 text-blue-400" strokeWidth={1.4} aria-hidden />
            )}
            <div className="space-y-1">
              <p className="text-lg font-semibold text-zinc-200">
                {upToDate ? "You're up to date" : "Update available"}
              </p>
              {status && (
                <p className="font-mono text-sm text-zinc-500">
                  {status.update_available && status.latest_short
                    ? `${status.current_short} → ${status.latest_short}`
                    : `version ${status.current_short}`}
                  {status.behind > 0 ? `  (${status.behind} behind)` : ""}
                </p>
              )}
              {status && !status.fetch_ok && (
                <p className="text-xs text-amber-500">Couldn’t reach the server — showing last known.</p>
              )}
            </div>

            {error && <Banner kind="error" text={error} />}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={check}
                className="flex h-11 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-5 text-sm font-semibold text-zinc-100"
              >
                <RefreshCw className="h-4 w-4" /> Check again
              </button>
              <button
                type="button"
                onClick={startUpdate}
                disabled={!status?.update_available}
                className="h-11 rounded-lg bg-blue-600 px-6 text-sm font-semibold text-white disabled:opacity-40"
              >
                Update Now
              </button>
            </div>
          </>
        )}
      </div>
    </PanelShell>
  );
}
