"use client";

import { useEffect, useMemo, useState } from "react";

type Overview = {
  rfid_tags_scanned: number;
  moves_asset_list_last_sync: string | null;
  registration: {
    status: "registered" | "pre_registered" | "revoked" | "unknown" | string;
    name: string | null;
  };
};

type SyncMove  = { id: number; name: string | null };
type SyncEvent = { id: number; name: string | null };
type CloudSyncLite = {
  moves: SyncMove[];
  events: SyncEvent[];
};

type SelectionKind = "move" | "event" | null;
type ActiveSelection = {
  type: SelectionKind;
  id: number | null;
  name: string | null;
};

const POLL_INTERVAL_MS = 5_000;

const STATUS_DISPLAY: Record<
  string,
  { label: string; accent: "green" | "blue" | "red" | "zinc" }
> = {
  registered: { label: "Registered", accent: "green" },
  pre_registered: { label: "Awaiting pairing", accent: "blue" },
  revoked: { label: "De-registered", accent: "red" },
  unknown: { label: "Unknown", accent: "zinc" },
};

function fmtTime24(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// Compose select options. Each option's `value` encodes type + id so the
// onChange handler doesn't need a parallel lookup. Sentinel "" = none.
type Option = { value: string; label: string; group: "move" | "event" };
function encodeOptionValue(kind: "move" | "event", id: number): string {
  return `${kind}:${id}`;
}
function decodeOptionValue(
  v: string,
): { type: "move" | "event"; id: number } | null {
  const [k, idStr] = v.split(":");
  const id = Number.parseInt(idStr, 10);
  if ((k !== "move" && k !== "event") || !Number.isFinite(id)) return null;
  return { type: k, id };
}

export default function ConfigOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [cloud, setCloud] = useState<CloudSyncLite | null>(null);
  const [active, setActive] = useState<ActiveSelection | null>(null);
  const [pendingValue, setPendingValue] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/local/overview", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as Overview;
        if (!cancelled) setData(body);
      } catch {
        /* keep last good data */
      }
    }
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [cloudRes, activeRes] = await Promise.allSettled([
          fetch("/local/portal-data/cloud-sync", { cache: "no-store" }),
          fetch("/local/active-selection", { cache: "no-store" }),
        ]);
        if (!cancelled && cloudRes.status === "fulfilled" && cloudRes.value.ok) {
          const body = (await cloudRes.value.json()) as CloudSyncLite;
          setCloud({
            moves: body.moves ?? [],
            events: body.events ?? [],
          });
        }
        if (
          !cancelled &&
          activeRes.status === "fulfilled" &&
          activeRes.value.ok
        ) {
          const body = (await activeRes.value.json()) as ActiveSelection;
          setActive(body);
          if (body.type && body.id != null) {
            setPendingValue(encodeOptionValue(body.type, body.id));
          } else {
            setPendingValue("");
          }
        }
      } catch {
        /* keep current */
      }
    }
    load();
  }, []);

  const options: Option[] = useMemo(() => {
    const out: Option[] = [];
    for (const m of cloud?.moves ?? []) {
      if (!m?.id) continue;
      out.push({
        value: encodeOptionValue("move", m.id),
        label: m.name ?? `Move #${m.id}`,
        group: "move",
      });
    }
    for (const e of cloud?.events ?? []) {
      if (!e?.id) continue;
      out.push({
        value: encodeOptionValue("event", e.id),
        label: e.name ?? `Event #${e.id}`,
        group: "event",
      });
    }
    return out;
  }, [cloud]);

  function flash(kind: "success" | "error", text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 5500);
  }

  async function apply() {
    setBusy(true);
    try {
      const decoded = pendingValue ? decodeOptionValue(pendingValue) : null;
      const body =
        decoded === null
          ? { type: null, id: null }
          : { type: decoded.type, id: decoded.id };
      const res = await fetch("/local/active-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const respBody = (await res.json().catch(() => null)) as
        | ActiveSelection
        | { detail?: string }
        | null;
      if (res.ok && respBody && "type" in respBody) {
        setActive(respBody as ActiveSelection);
        const sel = respBody as ActiveSelection;
        flash(
          "success",
          sel.type && sel.id != null
            ? `Set active ${sel.type} to “${sel.name || `#${sel.id}`}”.`
            : "Cleared active selection.",
        );
      } else {
        const detail = (respBody as { detail?: string } | null)?.detail;
        flash("error", detail ?? "Failed to set active selection.");
      }
    } finally {
      setBusy(false);
    }
  }

  const reg =
    STATUS_DISPLAY[data?.registration.status ?? "unknown"] ??
    STATUS_DISPLAY.unknown;

  const dirty =
    (active?.type && active?.id != null
      ? encodeOptionValue(active.type, active.id)
      : "") !== pendingValue;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-zinc-500">StackPI admin portal</p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card
          label="RFID Tags Scanned"
          value={data ? data.rfid_tags_scanned.toLocaleString() : "—"}
          subtitle="local_rfid_raw_scans"
        />
        <Card
          label="Move Asset List Last Sync"
          value={fmtTime24(data?.moves_asset_list_last_sync ?? null)}
          subtitle={
            data?.moves_asset_list_last_sync
              ? new Date(data.moves_asset_list_last_sync).toLocaleDateString()
              : "never synced"
          }
        />
        <Card
          label="Registration Status"
          value={reg.label}
          subtitle={data?.registration.name ?? undefined}
          accent={reg.accent}
        />
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Active Move / Event</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Pick the move or event the Pi should treat as the current focus.
          Available choices come from the latest BaseCamp sync. The selection
          is persisted at{" "}
          <code className="font-mono">GET /local/active-selection</code> for
          other Pi-side code to reference.
        </p>

        {banner && (
          <div
            role="status"
            className={`mt-3 rounded-md border px-3 py-2 text-sm ${
              banner.kind === "success"
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {banner.text}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[16rem]">
            <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Selection
            </span>
            <select
              disabled={busy}
              value={pendingValue}
              onChange={(e) => setPendingValue(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm disabled:opacity-60"
            >
              <option value="">— None —</option>
              <optgroup label="Moves">
                {options
                  .filter((o) => o.group === "move")
                  .map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Events">
                {options
                  .filter((o) => o.group === "event")
                  .map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>

          <button
            type="button"
            onClick={apply}
            disabled={busy || !dirty}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Apply"}
          </button>
        </div>

        <p className="mt-3 text-xs text-zinc-500">
          Currently set to:{" "}
          {active?.type && active?.id != null ? (
            <span className="font-mono">
              {active.type} #{active.id}
              {active.name ? ` — ${active.name}` : ""}
            </span>
          ) : (
            <span className="text-zinc-400">none</span>
          )}
        </p>
      </section>
    </div>
  );
}

function Card({
  label,
  value,
  subtitle,
  accent = "zinc",
}: {
  label: string;
  value: string;
  subtitle?: string;
  accent?: "green" | "blue" | "red" | "zinc";
}) {
  const accentCls =
    accent === "green"
      ? "text-green-700"
      : accent === "blue"
        ? "text-blue-700"
        : accent === "red"
          ? "text-red-700"
          : "text-zinc-900";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <p className="text-xs uppercase tracking-widest text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${accentCls}`}>{value}</p>
      {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
    </div>
  );
}
