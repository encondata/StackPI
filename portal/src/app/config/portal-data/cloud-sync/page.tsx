"use client";

import { useEffect, useState, type ReactNode } from "react";

type Move = {
  id: number;
  name: string | null;
  scheduled_start: string | null;
  real_start_time: string | null;
  real_end_time: string | null;
  asset_count: number | null;
  status_id: number | null;
  status_name: string | null;
  status_color: string | null;
};

type Event = {
  id: number;
  name: string | null;
  description: string | null;
  event_type: string | null;
  client: number | null;
  scheduled_date: string | null;
  location: string | null;
  status_id: number | null;
  status_name: string | null;
  status_color: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type Person = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  rfid_tracker: string | null;
};

type MovesAsset = {
  id: number;
  moves_id: number | null;
  asset_id: number | null;
  asset_serial_number: string | null;
  priority_wave: number | null;
  asset_name: string | null;
  asset_rfid_tag: string | null;
  asset_make: string | null;
  asset_model: string | null;
};

type CloudSync = {
  moves: Move[];
  events: Event[];
  people: Person[];
  moves_assets: MovesAsset[];
  last_synced_at: string | null;
  last_fetched_at: string | null;
  last_error: string | null;
};

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

export default function PortalDataPage() {
  const [data, setData] = useState<CloudSync | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  async function load() {
    try {
      const res = await fetch("/local/portal-data/cloud-sync", {
        cache: "no-store",
      });
      if (res.ok) setData((await res.json()) as CloudSync);
    } catch {
      /* keep current */
    }
  }

  useEffect(() => {
    load();
  }, []);

  function flash(kind: "success" | "error", text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 5500);
  }

  async function refresh() {
    setBusy(true);
    try {
      const res = await fetch("/local/portal-data/refresh", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            moves_count?: number;
            events_count?: number;
            people_count?: number;
            moves_assets_count?: number;
          }
        | { detail?: string }
        | null;
      if (res.ok && body && "ok" in body && body.ok) {
        const m = (body as { moves_count?: number }).moves_count ?? 0;
        const e = (body as { events_count?: number }).events_count ?? 0;
        const p = (body as { people_count?: number }).people_count ?? 0;
        const a =
          (body as { moves_assets_count?: number }).moves_assets_count ?? 0;
        flash(
          "success",
          `Synced ${m} move(s), ${e} event(s), ${p} person/people, ${a} asset(s) from BaseCamp.`,
        );
      } else {
        const detail = (body as { detail?: string } | null)?.detail;
        flash("error", detail ?? "Sync failed.");
      }
    } finally {
      setBusy(false);
      await load();
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Portal Data</h1>
          <p className="text-sm text-zinc-500">
            Snapshots of cloud data the Pi pulls from BaseCamp at{" "}
            <code className="font-mono">api.serversherpa.com</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {banner && (
        <div
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {banner.text}
        </div>
      )}

      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="text-base font-semibold">Cloud Data</h2>
          <p className="text-xs text-zinc-500">
            Last synced:{" "}
            <span className="font-mono">{fmtDate(data?.last_synced_at)}</span>
            {data?.last_error && (
              <span className="ml-3 text-red-700">
                Last error: {data.last_error}
              </span>
            )}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 p-5 lg:grid-cols-2">
          <MovesPanel rows={data?.moves ?? []} />
          <EventsPanel rows={data?.events ?? []} />
        </div>
        <div className="border-t border-zinc-100 p-5">
          <PeoplePanel rows={data?.people ?? []} />
        </div>
        <div className="border-t border-zinc-100 p-5">
          <MovesAssetsPanel rows={data?.moves_assets ?? []} />
        </div>
      </section>
    </div>
  );
}

// Shared wrapper — header is always visible (so the operator can see the
// count and reopen it), the table is mounted only when expanded. Default
// is collapsed so the page loads compactly.
function CollapsibleSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          aria-hidden
          className={`inline-block text-zinc-400 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        >
          ▶
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {title}
          <span className="ml-2 font-mono text-zinc-400">({count})</span>
        </span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}


function MovesPanel({ rows }: { rows: Move[] }) {
  return (
    <CollapsibleSection title="Active moves" count={rows.length}>
      <div className="overflow-hidden rounded-md border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2 text-left">ID</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Assets</th>
              <th className="px-3 py-2 text-left">Scheduled start</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-xs text-zinc-400"
                >
                  No active moves cached. Click <strong>Refresh</strong> to
                  pull from BaseCamp.
                </td>
              </tr>
            )}
            {rows.map((m) => (
              <tr key={m.id} className="border-t border-zinc-100">
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {m.id}
                </td>
                <td className="px-3 py-2 text-zinc-800">{m.name || "—"}</td>
                <td className="px-3 py-2">
                  <StatusChip
                    label={m.status_name}
                    color={m.status_color}
                  />
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-700">
                  {m.asset_count ?? "—"}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                  {fmtDate(m.scheduled_start)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleSection>
  );
}

function EventsPanel({ rows }: { rows: Event[] }) {
  return (
    <CollapsibleSection title="Active events" count={rows.length}>
      <div className="overflow-hidden rounded-md border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2 text-left">ID</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Scheduled</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-xs text-zinc-400"
                >
                  No active events cached. Click <strong>Refresh</strong> to
                  pull from BaseCamp.
                </td>
              </tr>
            )}
            {rows.map((e) => (
              <tr key={e.id} className="border-t border-zinc-100">
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {e.id}
                </td>
                <td className="px-3 py-2 text-zinc-800">{e.name || "—"}</td>
                <td className="px-3 py-2 text-xs text-zinc-700">
                  {e.event_type || "—"}
                </td>
                <td className="px-3 py-2">
                  <StatusChip
                    label={e.status_name}
                    color={e.status_color}
                  />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                  {fmtDate(e.scheduled_date)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleSection>
  );
}

function PeoplePanel({ rows }: { rows: Person[] }) {
  return (
    <CollapsibleSection title="People" count={rows.length}>
      <div className="overflow-hidden rounded-md border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2 text-left">ID</th>
              <th className="px-3 py-2 text-left">First name</th>
              <th className="px-3 py-2 text-left">Last name</th>
              <th className="px-3 py-2 text-left">Display name</th>
              <th className="px-3 py-2 text-left">RFID tracker</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-xs text-zinc-400"
                >
                  No people cached. Click <strong>Refresh</strong> to pull
                  from BaseCamp.
                </td>
              </tr>
            )}
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-zinc-100">
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {p.id}
                </td>
                <td className="px-3 py-2 text-zinc-800">
                  {p.first_name || "—"}
                </td>
                <td className="px-3 py-2 text-zinc-800">
                  {p.last_name || "—"}
                </td>
                <td className="px-3 py-2 text-zinc-800">
                  {p.display_name || "—"}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                  {p.rfid_tracker || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleSection>
  );
}

function MovesAssetsPanel({ rows }: { rows: MovesAsset[] }) {
  return (
    <CollapsibleSection title="Moves assets" count={rows.length}>
      <div className="overflow-hidden rounded-md border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2 text-left">ID</th>
              <th className="px-3 py-2 text-left">Move</th>
              <th className="px-3 py-2 text-right">Wave</th>
              <th className="px-3 py-2 text-left">Asset</th>
              <th className="px-3 py-2 text-left">Make / Model</th>
              <th className="px-3 py-2 text-left">Serial</th>
              <th className="px-3 py-2 text-left">RFID tag</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-6 text-center text-xs text-zinc-400"
                >
                  No active-move assets cached. Click <strong>Refresh</strong>{" "}
                  to pull from BaseCamp.
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-zinc-100">
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {a.id}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                  {a.moves_id ?? "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-xs text-zinc-700">
                  {a.priority_wave ?? "—"}
                </td>
                <td className="px-3 py-2 text-zinc-800">
                  {a.asset_name || "—"}
                  {a.asset_id != null && (
                    <span className="ml-1 font-mono text-[10px] text-zinc-400">
                      #{a.asset_id}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-700">
                  {a.asset_make || a.asset_model
                    ? `${a.asset_make ?? "?"} / ${a.asset_model ?? "?"}`
                    : "—"}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                  {a.asset_serial_number || "—"}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                  {a.asset_rfid_tag || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleSection>
  );
}

function StatusChip({
  label,
  color,
}: {
  label: string | null;
  color: string | null;
}) {
  if (!label) return <span className="text-xs text-zinc-400">—</span>;
  const swatch = color || "#9ca3af";
  return (
    <span className="inline-flex items-center gap-1.5 rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: swatch }}
        aria-hidden
      />
      {label}
    </span>
  );
}
