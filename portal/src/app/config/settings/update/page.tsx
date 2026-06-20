"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Admin port of the touchscreen Update panel. Same backend
// (/local/update/{status,start}): check current vs latest git revision, run the
// updater (deploy.sh in a transient unit, reboot on success), stream its log.

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

export default function SoftwareUpdatePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const fetchStatus = useCallback(async (): Promise<Status | null> => {
    const r = await fetch("/local/update/status", { cache: "no-store" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    return (await r.json()) as Status;
  }, []);

  // Initial check. If a run is already in flight, drop into the streaming view.
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

  // Poll while updating; stop at a terminal state. Once the device reboots,
  // fetches start failing — expected, so swallow it.
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
      setStatus(await fetchStatus());
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

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Software Update</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Pulls the latest version from git, rebuilds, and reboots the device.
      </p>

      {phase === "updating" && status ? (
        <UpdatingView status={status} logRef={logRef} />
      ) : (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          {phase === "loading" ? (
            <p className="text-sm text-zinc-500">Checking for updates…</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-base font-semibold text-zinc-900">
                    {status && !status.update_available
                      ? "You’re up to date"
                      : "Update available"}
                  </p>
                  {status && (
                    <p className="mt-0.5 font-mono text-xs text-zinc-500">
                      {status.update_available && status.latest_short
                        ? `${status.current_short} → ${status.latest_short}`
                        : `version ${status.current_short}`}
                      {status.behind > 0 ? `  (${status.behind} behind)` : ""}
                      {status.branch ? `  ·  ${status.branch}` : ""}
                    </p>
                  )}
                  {status && !status.fetch_ok && (
                    <p className="mt-1 text-xs text-amber-600">
                      Couldn’t reach the server — showing last known.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={check}
                    className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    Check again
                  </button>
                  <button
                    type="button"
                    onClick={startUpdate}
                    disabled={!status?.update_available}
                    className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
                  >
                    Update Now
                  </button>
                </div>
              </div>

              {error && (
                <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function UpdatingView({
  status,
  logRef,
}: {
  status: Status;
  logRef: React.RefObject<HTMLPreElement | null>;
}) {
  const done = status.state === "success";
  const failed = status.state === "failed";
  return (
    <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <p className="text-base font-semibold text-zinc-900">
        {done
          ? "Update complete — rebooting…"
          : failed
            ? "Update failed"
            : "Updating…"}
      </p>
      {done && (
        <p className="mt-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
          The device will restart and come back on the new version shortly.
        </p>
      )}
      {failed && (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          The update did not finish. The device is still running the previous
          version.
        </p>
      )}
      <pre
        ref={logRef}
        className="mt-4 max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300"
      >
        {status.log_tail || "Starting…"}
      </pre>
    </div>
  );
}
