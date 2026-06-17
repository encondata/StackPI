"use client";

import { useEffect, useState } from "react";

type Diagnostics = {
  engine_log_tail?: string[];
  services?: Record<string, string>;
};

type MatchData = {
  name?: string | null;
  asset_serial_number?: string | null;
  asset_make?: string | null;
  asset_model?: string | null;
};
type MatchRow = {
  match_id: number;
  scan_id: number;
  id_hex: string | null;
  match_type: string;
  match_data: MatchData;
  matched_at: string | null;
  reader_name: string | null;
  event_timestamp: string | null;
};
type MatchesResponse = {
  matches: MatchRow[];
  limit: number;
};

type UploadQueue = {
  counts: { pending: number; sent: number; acked: number; failed: number };
  batch_size: number;
  max_batch_size: number;
  in_single_mode: boolean;
  single_streak: number;
  single_threshold: number;
};

const POLL_MS = 5_000;
const MATCHES_LIMIT = 100;

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  // Postgres-style strings can come back with "-05" instead of "-05:00".
  const normalized = iso.replace(" ", "T").replace(/([+-])(\d{2})$/, "$1$2:00");
  const d = new Date(normalized);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString([], { hour12: false });
}

function formatDetail(row: MatchRow): string {
  const data = row.match_data ?? {};
  if (row.match_type === "asset") {
    const serial = (data.asset_serial_number ?? "").toString().trim();
    const mm = [data.asset_make ?? "", data.asset_model ?? ""]
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .join(" ");
    return [serial, mm].filter(Boolean).join(" - ") || "—";
  }
  if (row.match_type === "person") {
    return (data.name ?? "").toString().trim() || "—";
  }
  // Forward-compat for future lookup sources — dump JSON so the operator
  // can still see what came back.
  try {
    return JSON.stringify(data);
  } catch {
    return "—";
  }
}

export default function LogsPage() {
  const [log, setLog] = useState<string[]>([]);
  const [services, setServices] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [queue, setQueue] = useState<UploadQueue | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [diag, matchesRes, queueRes] = await Promise.allSettled([
          fetch("/local/diagnostics", { cache: "no-store" }),
          fetch(
            `/local/rfid/matches/recent?limit=${MATCHES_LIMIT}`,
            { cache: "no-store" },
          ),
          fetch("/local/rfid/upload-queue", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (diag.status === "fulfilled" && diag.value.ok) {
          const data = (await diag.value.json()) as Diagnostics;
          setLog(data.engine_log_tail ?? []);
          setServices(data.services ?? {});
          setErr(null);
        } else if (diag.status === "rejected") {
          setErr(String(diag.reason));
        }
        if (matchesRes.status === "fulfilled" && matchesRes.value.ok) {
          const data = (await matchesRes.value.json()) as MatchesResponse;
          setMatches(data.matches ?? []);
        }
        if (queueRes.status === "fulfilled" && queueRes.value.ok) {
          const data = (await queueRes.value.json()) as UploadQueue;
          setQueue(data);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
        <p className="text-sm text-zinc-500">
          RFID matches, service status, recent engine log lines — refreshes
          every {POLL_MS / 1000}s.
        </p>
      </header>

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </div>
      )}

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Scan Upload Queue</h2>
          <span className="text-xs text-zinc-500">
            local_rfid_processed_scans &middot; uploader runs every 30s
          </span>
        </div>
        {queue ? (
          <>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <QueueStat label="Pending"
                         value={queue.counts.pending}
                         tone={queue.counts.pending > 0 ? "amber" : "zinc"} />
              <QueueStat label="Sent (in flight)"
                         value={queue.counts.sent}
                         tone="zinc" />
              <QueueStat label="Acked"
                         value={queue.counts.acked}
                         tone="green" />
              <QueueStat label="Failed"
                         value={queue.counts.failed}
                         tone={queue.counts.failed > 0 ? "red" : "zinc"} />
            </dl>
            <p className="mt-3 text-xs text-zinc-500">
              Batch size:{" "}
              <span className="font-mono">{queue.batch_size}</span>
              {" / "}
              <span className="font-mono">{queue.max_batch_size}</span>
              {queue.in_single_mode && (
                <>
                  {" "}
                  &middot; single-mode (will escalate after{" "}
                  <span className="font-mono">
                    {queue.single_threshold - queue.single_streak}
                  </span>{" "}
                  more successful upload(s))
                </>
              )}
            </p>
          </>
        ) : (
          <p className="text-sm text-zinc-500">(no data yet)</p>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">RFID Matches</h2>
          <span className="text-xs text-zinc-500">
            Most recent {MATCHES_LIMIT} · newest first
          </span>
        </div>
        {matches.length === 0 ? (
          <p className="text-sm text-zinc-500">(no matches logged yet)</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs uppercase tracking-wider text-zinc-500">
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">Reader</th>
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Detail</th>
                  <th className="py-2 font-medium">Tag ID</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr
                    key={m.match_id}
                    className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                  >
                    <td className="py-1.5 pr-3 font-mono text-xs tabular-nums text-zinc-700">
                      {formatTs(m.event_timestamp ?? m.matched_at)}
                    </td>
                    <td className="py-1.5 pr-3 text-zinc-800">
                      {m.reader_name ?? "Unknown"}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={
                          "inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium " +
                          (m.match_type === "asset"
                            ? "bg-blue-50 text-blue-700"
                            : m.match_type === "person"
                              ? "bg-purple-50 text-purple-700"
                              : "bg-zinc-100 text-zinc-700")
                        }
                      >
                        {m.match_type}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-zinc-800">
                      {formatDetail(m)}
                    </td>
                    <td className="py-1.5 font-mono text-xs text-zinc-500">
                      {m.id_hex ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Services</h2>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {Object.entries(services).map(([name, state]) => (
            <div key={name} className="rounded-md border border-zinc-100 bg-zinc-50 p-3">
              <dt className="truncate font-mono text-xs text-zinc-500">{name}</dt>
              <dd
                className={`mt-1 font-semibold ${
                  state === "active" ? "text-green-700" : "text-red-700"
                }`}
              >
                {state}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-900 shadow-sm">
        <div className="border-b border-zinc-800 px-4 py-2">
          <p className="font-mono text-xs uppercase tracking-widest text-zinc-400">
            stackpi-engine.service · last 30 lines
          </p>
        </div>
        <pre className="max-h-[60vh] overflow-y-auto p-4 font-mono text-xs leading-relaxed text-zinc-100">
          {log.length > 0 ? log.join("\n") : "(no log lines yet)"}
        </pre>
      </section>
    </div>
  );
}

function QueueStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "amber" | "red" | "zinc";
}) {
  const valueCls =
    tone === "green"
      ? "text-green-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "red"
          ? "text-red-700"
          : "text-zinc-800";
  return (
    <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3">
      <dt className="truncate text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd className={`mt-1 font-mono text-xl font-semibold tabular-nums ${valueCls}`}>
        {value.toLocaleString()}
      </dd>
    </div>
  );
}
