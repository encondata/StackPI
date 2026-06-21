"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Admin Software Update — pick a branch + commit and deploy it. Backed by
// /local/update/{branches,commits,status,start}: the updater switches the
// device to the chosen branch/commit, rebuilds (deploy.sh in a transient unit),
// and reboots; the log streams here. The touchscreen panel keeps using the
// no-params defaults.

type Status = {
  branch: string;
  current_branch: string;
  current_short: string;
  target_short: string | null;
  behind: number;
  update_available: boolean;
  fetch_ok: boolean;
  state: "idle" | "running" | "success" | "failed";
  log_tail: string;
};

type Commit = {
  sha: string;
  short: string;
  date: string;
  author: string;
  subject: string;
  body: string;
};
type Phase = "loading" | "idle" | "updating";

const POLL_MS = 1500;

export default function SoftwareUpdatePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [commits, setCommits] = useState<Commit[]>([]);
  const [commit, setCommit] = useState(""); // "" = branch tip

  const logRef = useRef<HTMLPreElement>(null);

  const fetchStatus = useCallback(
    async (br: string, co: string): Promise<Status> => {
      const qs = new URLSearchParams();
      if (br) qs.set("branch", br);
      if (co) qs.set("commit", co);
      const r = await fetch(`/local/update/status?${qs.toString()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      return (await r.json()) as Status;
    },
    []
  );

  const loadCommits = useCallback(async (br: string): Promise<Commit[]> => {
    const r = await fetch(`/local/update/commits?branch=${encodeURIComponent(br)}`, {
      cache: "no-store",
    });
    if (!r.ok) return [];
    const d = (await r.json()) as { commits?: Commit[] };
    return d.commits ?? [];
  }, []);

  // Initial load: branches → commits(current) → status. Await-first so we never
  // setState synchronously in the effect.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const br = await fetch("/local/update/branches", { cache: "no-store" });
        const bd = (await br.json()) as { current_branch: string; branches: string[] };
        if (!active) return;
        const initial = bd.current_branch;
        setBranches(bd.branches.length ? bd.branches : [initial]);
        setBranch(initial);
        const cs = await loadCommits(initial);
        if (!active) return;
        setCommits(cs);
        const s = await fetchStatus(initial, "");
        if (!active) return;
        setStatus(s);
        setPhase(s.state === "running" ? "updating" : "idle");
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : "failed to load update info");
          setPhase("idle");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [fetchStatus, loadCommits]);

  // Poll while updating; stop at a terminal state. Reboot makes fetches fail —
  // expected, so swallow it.
  useEffect(() => {
    if (phase !== "updating") return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const s = await fetchStatus(branch, commit);
        if (cancelled) return;
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
  }, [phase, branch, commit, fetchStatus]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log_tail]);

  async function refreshStatus(br: string, co: string) {
    setError(null);
    setPhase("loading");
    try {
      setStatus(await fetchStatus(br, co));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to check");
    }
    setPhase("idle");
  }

  async function onBranchChange(br: string) {
    setBranch(br);
    setCommit("");
    setError(null);
    setPhase("loading");
    try {
      setCommits(await loadCommits(br));
      setStatus(await fetchStatus(br, ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load branch");
    }
    setPhase("idle");
  }

  async function startUpdate() {
    setError(null);
    try {
      const r = await fetch("/local/update/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch, commit: commit || undefined }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(b?.detail ?? `start ${r.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start update");
      return;
    }
    setStatus((s) => (s ? { ...s, state: "running", log_tail: "" } : s));
    setPhase("updating");
  }

  // The commit the deploy will land on: the picked one, or the tip ("").
  const selectedCommit =
    commits.find((c) => c.sha === commit) ?? commits[0] ?? null;
  const commitBody = selectedCommit
    ? selectedCommit.body.split("\n").slice(1).join("\n").trim()
    : "";

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Software Update</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Deploy a branch &amp; commit from git, then rebuild and reboot the device.
      </p>

      {phase === "updating" && status ? (
        <UpdatingView status={status} logRef={logRef} />
      ) : (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          {phase === "loading" ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Branch
                  </span>
                  <select
                    value={branch}
                    onChange={(e) => onBranchChange(e.target.value)}
                    className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
                  >
                    {branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                        {status && b === status.current_branch ? "  (current)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Commit
                  </span>
                  <select
                    value={commit}
                    onChange={(e) => {
                      setCommit(e.target.value);
                      refreshStatus(branch, e.target.value);
                    }}
                    className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
                  >
                    <option value="">latest (tip)</option>
                    {commits.map((c) => (
                      <option key={c.sha} value={c.sha}>
                        {c.short} — {c.subject.slice(0, 48)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {selectedCommit && (
                <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Commit details
                  </p>
                  <p className="mt-1 text-sm font-semibold text-zinc-900">
                    {selectedCommit.subject}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-zinc-500">
                    {selectedCommit.short} · {selectedCommit.sha}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {selectedCommit.author} ·{" "}
                    {new Date(selectedCommit.date).toLocaleString()}
                  </p>
                  {commitBody && (
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-zinc-200 bg-white p-2 font-mono text-xs text-zinc-700">
                      {commitBody}
                    </pre>
                  )}
                </div>
              )}

              {status && (
                <p className="mt-4 font-mono text-xs text-zinc-600">
                  current{" "}
                  <span className="font-semibold">
                    {status.current_branch}@{status.current_short}
                  </span>{" "}
                  → target{" "}
                  <span className="font-semibold">
                    {status.branch}@{status.target_short ?? "?"}
                  </span>
                  {status.update_available ? "" : "  (already deployed)"}
                </p>
              )}
              {status && !status.fetch_ok && (
                <p className="mt-1 text-xs text-amber-600">
                  Couldn’t reach the server — showing last known.
                </p>
              )}

              {error && (
                <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {error}
                </p>
              )}

              <div className="mt-5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => refreshStatus(branch, commit)}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={startUpdate}
                  className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
                >
                  Deploy selected
                </button>
              </div>
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
        {done ? "Update complete — rebooting…" : failed ? "Update failed" : "Updating…"}
      </p>
      {done && (
        <p className="mt-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
          The device will restart and come back on the new version shortly.
        </p>
      )}
      {failed && (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          The update did not finish. The device is still running the previous version.
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
