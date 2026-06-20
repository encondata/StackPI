"use client";

import { useCallback, useEffect, useState } from "react";

type OutputMethod = "api" | "mqtt" | "disable";

type Reader = {
  id: number;
  name: string;
  reader_type: string | null;
  scheme: "http" | "https" | string;
  address: string;
  port: number | null;
  antennas: number | null;
  notes: string | null;
  enabled: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  admin_username: string | null;
  last_status_at: string | null;
  last_status: CloudStatus | null;
  last_error: string | null;
  production_method: OutputMethod | string;
  production_url: string | null;
  local_method: OutputMethod | string;
  local_url: string | null;
};

// Shape of GET /cloud/status as returned by the FX9600 IoT Connector.
// Field types are conservative because the firmware sometimes ships numeric
// fields as JSON strings (esp. byte counts) — readers handle both.
type Usage = {
  total?: number | string;
  free?: number | string;
  used?: number | string;
};

type CloudStatus = {
  uptime?: string;
  systemTime?: string;
  ram?: Usage;
  flash?: {
    rootFileSystem?: Usage;
    platform?: Usage;
    readerConfig?: Usage;
    readerData?: Usage;
  };
  cpu?: { user?: number | string; system?: number | string };
  radioConnection?: string;
  antennas?: Record<string, string>;
  temperature?: number | string;
  // Both spellings have appeared in Zebra examples; render whichever exists.
  radioActivity?: string;
  radioActivitiy?: string;
  powerSource?: string;
  powerNegotiation?: string;
  ntp?: { offset?: number | string; reach?: number | string };
  interfaceConnectionStatus?: {
    data?: Array<{
      interface?: string;
      description?: string;
      connectionStatus?: string;
      connectionError?: string;
    }>;
  };
  [k: string]: unknown;
};

type Counts = { total: number; active: number; scans: number };
type Payload = { readers: Reader[]; counts: Counts };


type ModelDef = {
  label: string;
  value: string;
  scheme: "http" | "https";
  port: number;
  antennas: number;
};

// Zebra FX9600/FX7500 expose the IoT Connector REST API; our deployment uses
// plain HTTP on port 80. Impinj readers (R420, R700) don't run IoT Connector
// and use raw LLRP on 5084 (not actually HTTP/HTTPS; scheme is just a label).
const MODELS: ModelDef[] = [
  { label: "Zebra FX9600 (IoT Connector)", value: "Zebra FX9600", scheme: "http",  port: 80,   antennas: 4 },
  { label: "Zebra FX7500 (IoT Connector)", value: "Zebra FX7500", scheme: "http",  port: 80,   antennas: 4 },
  { label: "Impinj R420 (LLRP)",           value: "Impinj R420",  scheme: "http",  port: 5084, antennas: 4 },
  { label: "Impinj R700 (LLRP)",           value: "Impinj R700",  scheme: "http",  port: 5084, antennas: 4 },
  { label: "Other",                        value: "Other",        scheme: "http",  port: 80,   antennas: 4 },
];

const DEFAULT_MODEL = MODELS[0];
const POLL_MS = 10_000;

export default function RFIDReadersPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [busyAdd, setBusyAdd] = useState(false);
  const [busyEdit, setBusyEdit] = useState(false);
  const [busyDelete, setBusyDelete] = useState(false);
  const [editTarget, setEditTarget] = useState<Reader | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Reader | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Reader | null>(null);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [refreshBusy, setRefreshBusy] = useState<Record<number, boolean>>({});
  const [controlBusy, setControlBusy] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/local/rfid/readers", { cache: "no-store" });
        if (res.ok && !cancelled) setData((await res.json()) as Payload);
      } catch {
        /* keep last good data */
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function flash(kind: "success" | "error", text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 5500);
  }

  async function refreshNow() {
    try {
      const res = await fetch("/local/rfid/readers", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as Payload);
    } catch {}
  }

  async function refreshReaderStatus(reader: Reader) {
    setRefreshBusy((b) => ({ ...b, [reader.id]: true }));
    try {
      const res = await fetch(
        `/local/rfid/readers/${reader.id}/poll-status`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string | null; status?: CloudStatus }
        | { detail?: string }
        | null;
      if (res.ok && body && "ok" in body && body.ok) {
        flash("success", `Refreshed status for “${reader.name}”.`);
      } else {
        const detail =
          body && "detail" in body
            ? (body as { detail?: string }).detail
            : body && "error" in body
              ? (body as { error?: string | null }).error
              : undefined;
        flash("error", detail ?? `Failed to refresh “${reader.name}”.`);
      }
    } finally {
      setRefreshBusy((b) => ({ ...b, [reader.id]: false }));
      // Pick up the new last_status / last_status_at right away so the modal
      // re-renders with fresh data. The useEffect below also syncs
      // detailsTarget to the updated list row.
      await refreshNow();
    }
  }

  // Keep the open Details modal in sync with the latest list payload.
  // Without this, clicking Refresh writes fresh fields to the DB and updates
  // `data`, but `detailsTarget` still holds the row snapshot taken when the
  // modal opened.
  useEffect(() => {
    if (!detailsTarget || !data) return;
    const fresh = data.readers.find((r) => r.id === detailsTarget.id);
    if (fresh && fresh.last_status_at !== detailsTarget.last_status_at) {
      setDetailsTarget(fresh);
    }
  }, [data, detailsTarget]);

  async function controlReader(reader: Reader, verb: "start" | "stop") {
    setControlBusy((b) => ({ ...b, [reader.id]: true }));
    try {
      const res = await fetch(
        `/local/rfid/readers/${reader.id}/${verb}`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; status?: CloudStatus; error?: string | null }
        | { detail?: string }
        | null;
      if (res.ok && body && "ok" in body && body.ok) {
        flash(
          "success",
          `${verb === "start" ? "Started" : "Stopped"} reader “${reader.name}”.`,
        );
      } else {
        const detail =
          body && "detail" in body
            ? (body as { detail?: string }).detail
            : body && "error" in body
              ? (body as { error?: string | null }).error
              : undefined;
        flash("error", detail ?? `Failed to ${verb} reader “${reader.name}”.`);
      }
    } finally {
      setControlBusy((b) => ({ ...b, [reader.id]: false }));
      // Pick up the post-action /cloud/status that the backend wrote.
      await refreshNow();
    }
  }

  async function submitNewReader(form: ReaderForm) {
    setBusyAdd(true);
    try {
      const res = await fetch("/local/rfid/readers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          reader_type: form.reader_type.trim() || null,
          scheme: form.scheme,
          address: form.address.trim(),
          port: form.port ? Number(form.port) : null,
          antennas: form.antennas ? Number(form.antennas) : null,
          admin_username: form.admin_username.trim() || null,
          admin_password: form.admin_password || null,
          notes: form.notes.trim() || null,
          production_method: form.production_method,
          production_url: form.production_url.trim() || null,
          local_method: form.local_method,
          local_url: form.local_url.trim() || null,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setShowAdd(false);
        flash("success", `Added reader “${form.name}”.`);
        if (body) setData(body as Payload);
        else refreshNow();
      } else {
        flash("error", body?.detail ?? "Failed to add reader.");
      }
    } finally {
      setBusyAdd(false);
    }
  }

  async function submitEditReader(reader: Reader, form: ReaderForm) {
    setBusyEdit(true);
    try {
      const res = await fetch(`/local/rfid/readers/${reader.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          reader_type: form.reader_type.trim() || null,
          scheme: form.scheme,
          address: form.address.trim(),
          port: form.port ? Number(form.port) : null,
          antennas: form.antennas ? Number(form.antennas) : null,
          admin_username: form.admin_username.trim() || null,
          // Blank password = no change (handled API-side).
          admin_password: form.admin_password || null,
          notes: form.notes.trim() || null,
          production_method: form.production_method,
          production_url: form.production_url.trim() || null,
          local_method: form.local_method,
          local_url: form.local_url.trim() || null,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        flash("error", body?.detail ?? "Failed to save changes.");
        return;
      }
      if (body) setData(body as Payload);
      else refreshNow();

      // When this reader delivers locally over HTTP, point its IoT-Connector
      // endpoint at the Local URL too. The DB save above already succeeded —
      // a reader-push failure only downgrades the banner, never blocks the save.
      let readerOk = true;
      let readerMsg = "";
      const localUrl = form.local_url.trim();
      if (form.local_method === "api" && localUrl) {
        try {
          const pr = await fetch(
            `/local/rfid/readers/${reader.id}/endpoint-url`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: localUrl }),
            }
          );
          if (pr.ok) {
            readerMsg = " Reader endpoint pointed at the Local URL.";
          } else {
            const pb = (await pr.json().catch(() => null)) as { detail?: string } | null;
            readerOk = false;
            readerMsg = ` Reader endpoint NOT updated: ${pb?.detail ?? `HTTP ${pr.status}`}.`;
          }
        } catch {
          readerOk = false;
          readerMsg = " Reader endpoint NOT updated: could not reach the reader.";
        }
      }

      setEditTarget(null);
      flash(
        readerOk ? "success" : "error",
        `Saved changes to “${form.name}”.${readerMsg}`
      );
    } finally {
      setBusyEdit(false);
    }
  }

  async function confirmDeleteReader(reader: Reader) {
    setBusyDelete(true);
    try {
      const res = await fetch(`/local/rfid/readers/${reader.id}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setDeleteTarget(null);
        flash("success", `Deleted reader “${reader.name}”.`);
        if (body) setData(body as Payload);
        else refreshNow();
      } else {
        flash("error", body?.detail ?? "Failed to delete reader.");
      }
    } finally {
      setBusyDelete(false);
    }
  }

  const counts = data?.counts ?? { total: 0, active: 0, scans: 0 };
  const readers = data?.readers ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">RFID Readers</h1>
        <p className="text-sm text-zinc-500">
          Configured RFID reader hardware. Each enabled reader is polled
          automatically in the background; status and system info update on
          their own.
        </p>
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card label="Total Readers" value={counts.total.toLocaleString()} />
        <Card
          label="Active Readers"
          value={counts.active.toLocaleString()}
          accent={counts.active > 0 ? "green" : "zinc"}
          subtitle={
            counts.total > 0
              ? `${counts.active} of ${counts.total} enabled`
              : undefined
          }
        />
        <Card
          label="Tags Scanned"
          value={counts.scans.toLocaleString()}
          subtitle="lifetime, raw"
        />
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex items-center justify-between p-4">
          <div>
            <h2 className="text-base font-semibold">Configured readers</h2>
            <p className="text-[11px] text-zinc-500">
              Background polling every ~30s
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            + Add New Reader
          </button>
        </div>
        <div className="overflow-hidden border-t border-zinc-100">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-left">Address</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Last poll</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {readers.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100">
                  <td className="px-3 py-2 font-medium">
                    <button
                      type="button"
                      onClick={() => setDetailsTarget(r)}
                      className="text-left text-blue-700 hover:underline"
                      title="View system info"
                    >
                      {r.name}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-zinc-600">
                    {r.reader_type ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                    {r.scheme ?? "http"}://{r.address}
                    {r.port ? `:${r.port}` : ""}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge reader={r} />
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {r.last_status_at
                      ? new Date(r.last_status_at).toLocaleTimeString()
                      : r.last_seen_at
                        ? new Date(r.last_seen_at).toLocaleTimeString()
                        : "never"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <ControlButton
                        reader={r}
                        busy={!!controlBusy[r.id]}
                        onAction={(verb) => controlReader(r, verb)}
                      />
                      <button
                        type="button"
                        onClick={() => setEditTarget(r)}
                        className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(r)}
                        className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {readers.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-xs text-zinc-400"
                  >
                    No readers configured yet. Click{" "}
                    <span className="font-semibold">+ Add New Reader</span> to
                    register one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showAdd && (
        <AddReaderModal
          busy={busyAdd}
          onCancel={() => setShowAdd(false)}
          onSubmit={submitNewReader}
        />
      )}

      {editTarget && (
        <EditReaderModal
          reader={editTarget}
          busy={busyEdit}
          onCancel={() => setEditTarget(null)}
          onSubmit={(form) => submitEditReader(editTarget, form)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          reader={deleteTarget}
          busy={busyDelete}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => confirmDeleteReader(deleteTarget)}
        />
      )}

      {detailsTarget && (
        <ReaderDetailsModal
          reader={detailsTarget}
          busy={!!refreshBusy[detailsTarget.id]}
          onClose={() => setDetailsTarget(null)}
          onEdit={() => {
            setDetailsTarget(null);
            setEditTarget(detailsTarget);
          }}
          onRefresh={() => refreshReaderStatus(detailsTarget)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reader endpoint config: raw-JSON editor (Edit modal) + key-details (Details).
// Both read/write via /local/rfid/readers/{id}/endpoint-config.
// ---------------------------------------------------------------------------

// Advanced editor: pull the reader's live endpointConfig on demand, edit the
// raw JSON, commit it back. Rendered as a section inside the Edit modal (so it
// only hits the reader when the operator clicks Pull, not on every Edit-open).
function EndpointConfigEditor({ reader }: { reader: Reader }) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function pull() {
    setPhase("loading");
    setError(null);
    setOkMsg(null);
    setNote(null);
    try {
      const r = await fetch(`/local/rfid/readers/${reader.id}/endpoint-config`, {
        cache: "no-store",
      });
      const b = (await r.json().catch(() => null)) as
        | { endpoint_config?: unknown; detail?: string }
        | null;
      if (!r.ok) {
        setError(b?.detail ?? `Failed to pull config (HTTP ${r.status}).`);
        setPhase("idle");
        return;
      }
      const ep = b?.endpoint_config ?? null;
      if (ep == null) setNote("This reader has no endpoint config set yet.");
      setText(JSON.stringify(ep ?? {}, null, 2));
      setPhase("ready");
    } catch {
      setError("Could not reach the API.");
      setPhase("idle");
    }
  }

  async function commit() {
    setError(null);
    setOkMsg(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Invalid JSON: ${e instanceof Error ? e.message : "parse error"}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("Endpoint config must be a JSON object.");
      return;
    }
    setPhase("saving");
    try {
      const r = await fetch(`/local/rfid/readers/${reader.id}/endpoint-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpointConfig: parsed }),
      });
      const b = (await r.json().catch(() => null)) as { detail?: string } | null;
      if (!r.ok) {
        setError(b?.detail ?? `Commit failed (HTTP ${r.status}).`);
        setPhase("ready");
        return;
      }
      setOkMsg("Committed to the reader.");
      setPhase("ready");
    } catch {
      setError("Could not reach the API.");
      setPhase("ready");
    }
  }

  const busy = phase === "loading" || phase === "saving";
  return (
    <div className="sm:col-span-2 mt-1 rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Reader endpoint config (raw JSON)
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            Advanced — pull the reader&apos;s live <code>endpointConfig</code>, edit,
            and commit it back. A bad value can disrupt delivery.
          </p>
        </div>
        <button
          type="button"
          onClick={pull}
          disabled={busy}
          className="whitespace-nowrap rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
        >
          {phase === "loading" ? "Pulling…" : phase === "idle" ? "Pull config" : "Re-pull"}
        </button>
      </div>

      {note && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {note}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
      {okMsg && (
        <p className="mt-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
          {okMsg}
        </p>
      )}

      {phase !== "idle" && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            disabled={busy}
            className="mt-2 w-full resize-y rounded-md border border-zinc-300 bg-white p-3 font-mono text-xs text-zinc-800 disabled:opacity-60"
            style={{ minHeight: "16rem" }}
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={commit}
              disabled={busy}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {phase === "saving" ? "Committing…" : "Commit endpoint to reader"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Read-only key details of the reader's endpointConfig data connections, shown
// in the Details modal. Auto-pulls on open.
type EpConnection = {
  name?: string;
  description?: string;
  type?: string;
  options?: {
    URL?: string;
    endpoint?: { hostName?: string; port?: number; protocol?: string };
    security?: { authenticationType?: string };
  };
};

function endpointAddress(c: EpConnection): string {
  if (c.options?.URL) return c.options.URL;
  const e = c.options?.endpoint;
  if (e?.hostName) {
    return `${e.protocol ? `${e.protocol}://` : ""}${e.hostName}${e.port ? `:${e.port}` : ""}`;
  }
  return "—";
}

function EndpointDetails({ reader }: { reader: Reader }) {
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [error, setError] = useState<string | null>(null);
  const [conns, setConns] = useState<EpConnection[]>([]);

  const load = useCallback(async (): Promise<
    { ok: true; conns: EpConnection[] } | { ok: false; error: string }
  > => {
    try {
      const r = await fetch(`/local/rfid/readers/${reader.id}/endpoint-config`, {
        cache: "no-store",
      });
      const b = (await r.json().catch(() => null)) as
        | {
            endpoint_config?: { data?: { event?: { connections?: EpConnection[] } } };
            detail?: string;
          }
        | null;
      if (!r.ok) return { ok: false, error: b?.detail ?? `HTTP ${r.status}` };
      const list = b?.endpoint_config?.data?.event?.connections;
      return { ok: true, conns: Array.isArray(list) ? list : [] };
    } catch {
      return { ok: false, error: "Could not reach the API." };
    }
  }, [reader.id]);

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await load();
      if (!active) return;
      if (res.ok) setConns(res.conns);
      else setError(res.error);
      setPhase("ready");
    })();
    return () => {
      active = false;
    };
  }, [load]);

  return (
    <div className="mt-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Endpoint (where the reader ships tag reads)
      </p>
      {phase === "loading" ? (
        <p className="mt-2 text-xs text-zinc-500">Loading endpoint config…</p>
      ) : error ? (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          Couldn’t read endpoint config: {error}
        </p>
      ) : conns.length === 0 ? (
        <p className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
          No data connections configured on this reader.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {conns.map((c, i) => (
            <div key={i} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-800">
                  {c.name || `Connection ${i + 1}`}
                </span>
                <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-zinc-600">
                  {c.type || "?"}
                </span>
              </div>
              <p className="mt-1 break-all font-mono text-xs text-zinc-700">
                {endpointAddress(c)}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                auth: {c.options?.security?.authenticationType ?? "—"}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit reader modal — reuses ReaderForm + AddReaderModal field layout
// ---------------------------------------------------------------------------

function asMethod(v: string | null | undefined): OutputMethod {
  return v === "mqtt" || v === "disable" ? v : "api";
}

function formFromReader(r: Reader): ReaderForm {
  return {
    name: r.name,
    reader_type: r.reader_type ?? "",
    scheme: (r.scheme === "https" ? "https" : "http") as "http" | "https",
    address: r.address,
    port: r.port != null ? String(r.port) : "",
    antennas: r.antennas != null ? String(r.antennas) : "",
    admin_username: r.admin_username ?? "admin",
    admin_password: "",
    notes: r.notes ?? "",
    production_method: asMethod(r.production_method),
    production_url: r.production_url ?? "",
    local_method: asMethod(r.local_method),
    local_url: r.local_url ?? "",
  };
}

function EditReaderModal({
  reader,
  busy,
  onCancel,
  onSubmit,
}: {
  reader: Reader;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (f: ReaderForm) => void;
}) {
  const [form, setForm] = useState<ReaderForm>(() => formFromReader(reader));
  const [showPw, setShowPw] = useState(false);
  const canSubmit = form.name.trim() && form.address.trim() && !busy;

  function onModelChange(value: string) {
    const m = MODELS.find((x) => x.value === value) ?? DEFAULT_MODEL;
    // Only update the model + scheme/port/antennas if the model is the changing thing,
    // not when the user has manually set those.
    setForm((f) => ({
      ...f,
      reader_type: m.value,
      scheme: m.scheme,
      port: String(m.port),
      antennas: String(m.antennas),
    }));
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Edit reader — {reader.name}</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Leave password blank to keep the existing one.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            required
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
          />

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Model
            </span>
            <select
              value={form.reader_type || DEFAULT_MODEL.value}
              onChange={(e) => onModelChange(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Scheme
            </span>
            <select
              value={form.scheme}
              onChange={(e) =>
                setForm({ ...form, scheme: e.target.value as "http" | "https" })
              }
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
            >
              <option value="http">http://</option>
              <option value="https">https:// (verify=False)</option>
            </select>
          </label>

          <Field
            label="Address"
            required
            mono
            value={form.address}
            onChange={(v) => setForm({ ...form, address: v })}
          />
          <Field
            label="Port"
            mono
            value={form.port}
            onChange={(v) => setForm({ ...form, port: v })}
          />
          <Field
            label="Antennas"
            value={form.antennas}
            onChange={(v) => setForm({ ...form, antennas: v })}
          />
          <Field
            label="Admin username"
            value={form.admin_username}
            onChange={(v) => setForm({ ...form, admin_username: v })}
          />

          <label className="block sm:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Admin password
              <span className="ml-1 text-[10px] font-normal lowercase text-zinc-400">
                (blank = unchanged)
              </span>
            </span>
            <div className="mt-1 flex gap-2">
              <input
                type={showPw ? "text" : "password"}
                value={form.admin_password}
                onChange={(e) =>
                  setForm({ ...form, admin_password: e.target.value })
                }
                placeholder="••••••••"
                className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <EventDeliverySection form={form} setForm={setForm} />

          <EndpointConfigEditor reader={reader} />

          <div className="sm:col-span-2">
            <Field
              label="Notes"
              value={form.notes}
              onChange={(v) => setForm({ ...form, notes: v })}
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(form)}
            disabled={!canSubmit}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm
// ---------------------------------------------------------------------------

function DeleteConfirmModal({
  reader,
  busy,
  onCancel,
  onConfirm,
}: {
  reader: Reader;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-red-700">Delete reader?</h3>
        <p className="mt-2 text-sm text-zinc-700">
          Permanently delete{" "}
          <strong>{reader.name}</strong> ({reader.address}). Tags already
          recorded in <code className="font-mono">local_rfid_raw_scans</code>{" "}
          will be kept.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:bg-red-400"
          >
            {busy ? "Deleting…" : "Delete reader"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reader details modal — system info from the last successful test
// ---------------------------------------------------------------------------

function ReaderDetailsModal({
  reader,
  busy,
  onClose,
  onEdit,
  onRefresh,
}: {
  reader: Reader;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRefresh: () => void;
}) {
  const status = reader.last_status ?? null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">{reader.name}</h3>
            <p className="mt-0.5 font-mono text-xs text-zinc-500">
              {reader.scheme ?? "http"}://{reader.address}
              {reader.port ? `:${reader.port}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
              title="Fetch /cloud/status now (also polled automatically)"
            >
              {busy ? "Refreshing…" : "Refresh"}
            </button>
            <StatusBadge reader={reader} />
          </div>
        </div>

        {!status && (
          <p className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500">
            No status data yet. The polling service refreshes every reader on
            the schedule set in{" "}
            <a
              href="/config/rfid/settings"
              className="text-blue-700 underline"
            >
              RFID Settings
            </a>
            , or click <strong>Refresh</strong> above to fetch now.
          </p>
        )}

        {status && <CloudStatusSections status={status} />}

        <section className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Event delivery
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <Detail
              label="Production method"
              value={reader.production_method?.toUpperCase()}
            />
            <Detail
              label="Production URL"
              value={reader.production_url}
              mono
            />
            <Detail
              label="Local method"
              value={reader.local_method?.toUpperCase()}
            />
            <Detail label="Local URL" value={reader.local_url} mono />
          </dl>
        </section>

        <section className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Local configuration
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <Detail label="Configured model" value={reader.reader_type} />
            <Detail
              label="Antennas (declared)"
              value={reader.antennas?.toString()}
            />
            <Detail label="Username" value={reader.admin_username} mono />
            <Detail
              label="Last polled"
              value={
                reader.last_status_at
                  ? new Date(reader.last_status_at).toLocaleString()
                  : "never"
              }
            />
            <Detail
              label="Last error"
              value={reader.last_error}
              className={reader.last_error ? "text-red-700" : ""}
            />
            <Detail label="Notes" value={reader.notes} />
          </dl>
        </section>

        <section className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <EndpointDetails reader={reader} />
        </section>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Edit reader
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// /cloud/status rendering (filled in by the 5-minute timer + manual Refresh)
// ---------------------------------------------------------------------------

function toNumber(v: number | string | undefined | null): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatBytes(v: number | string | undefined | null): string | null {
  const n = toNumber(v);
  if (n == null) return null;
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function usageRow(label: string, u: Usage | undefined): React.ReactNode {
  if (!u) return null;
  const free = formatBytes(u.free);
  const total = formatBytes(u.total);
  const used = formatBytes(u.used);
  const totalN = toNumber(u.total);
  const usedN = toNumber(u.used);
  const pct =
    totalN && totalN > 0 && usedN != null
      ? Math.min(100, Math.max(0, (usedN / totalN) * 100))
      : null;
  return (
    <div key={label}>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-zinc-700">{label}</span>
        <span className="font-mono tabular-nums text-zinc-500">
          {used ?? "—"} / {total ?? "—"}{free ? ` · ${free} free` : ""}
        </span>
      </div>
      {pct != null && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
          <div
            className={`h-full ${pct > 90 ? "bg-red-500" : pct > 75 ? "bg-yellow-500" : "bg-green-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function CloudStatusSections({ status }: { status: CloudStatus }) {
  const radioActivity = status.radioActivity ?? status.radioActivitiy ?? null;
  const sysTime = status.systemTime
    ? new Date(status.systemTime).toLocaleString()
    : null;
  const temp = toNumber(status.temperature);
  const cpuUser = toNumber(status.cpu?.user);
  const cpuSys = toNumber(status.cpu?.system);
  const ntpOffset = toNumber(status.ntp?.offset);
  const ntpReach = toNumber(status.ntp?.reach);
  const antennas = status.antennas ?? null;
  const connectors = status.interfaceConnectionStatus?.data ?? null;

  return (
    <>
      <section className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          System
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <Detail label="Uptime" value={status.uptime} mono />
          <Detail label="System time" value={sysTime} mono />
          <Detail label="Temperature" value={temp != null ? `${temp}°C` : null} />
          <Detail label="Power source" value={status.powerSource} />
          <Detail label="Power negotiation" value={status.powerNegotiation} />
          <Detail label="Radio connection" value={status.radioConnection} />
          <Detail label="Radio activity" value={radioActivity} />
          <Detail
            label="CPU"
            value={
              cpuUser != null || cpuSys != null
                ? `user ${cpuUser ?? "?"}% · system ${cpuSys ?? "?"}%`
                : null
            }
            mono
          />
        </dl>
      </section>

      {(status.ram || status.flash) && (
        <section className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Memory &amp; storage
          </p>
          <div className="mt-3 space-y-3">
            {status.ram && usageRow("RAM", status.ram)}
            {status.flash?.rootFileSystem &&
              usageRow("Root filesystem", status.flash.rootFileSystem)}
            {status.flash?.platform &&
              usageRow("Platform", status.flash.platform)}
            {status.flash?.readerConfig &&
              usageRow("Reader config", status.flash.readerConfig)}
            {status.flash?.readerData &&
              usageRow("Reader data", status.flash.readerData)}
          </div>
        </section>
      )}

      {antennas && Object.keys(antennas).length > 0 && (
        <section className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Antennas
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {Object.entries(antennas).map(([idx, st]) => {
              const connected = String(st).toLowerCase() === "connected";
              return (
                <span
                  key={idx}
                  className={`rounded px-2 py-0.5 font-mono text-[11px] tabular-nums ${
                    connected
                      ? "bg-green-100 text-green-800"
                      : "bg-zinc-100 text-zinc-500"
                  }`}
                  title={`Antenna ${idx}: ${st}`}
                >
                  #{idx} · {st}
                </span>
              );
            })}
          </div>
        </section>
      )}

      {connectors && connectors.length > 0 && (
        <section className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Outbound connectors
          </p>
          <ul className="mt-3 divide-y divide-zinc-100 text-sm">
            {connectors.map((c, i) => {
              const ok = String(c.connectionStatus).toLowerCase() === "connected";
              return (
                <li key={i} className="flex items-start gap-3 py-2">
                  <span
                    className={`mt-0.5 inline-flex shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${
                      ok
                        ? "bg-green-100 text-green-800"
                        : "bg-red-100 text-red-800"
                    }`}
                  >
                    {c.connectionStatus ?? "—"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-zinc-800">
                      {c.interface ?? "—"}
                    </p>
                    {c.description && (
                      <p className="truncate font-mono text-xs text-zinc-500">
                        {c.description}
                      </p>
                    )}
                    {c.connectionError && (
                      <p className="mt-0.5 text-xs text-red-700">
                        {c.connectionError}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(ntpOffset != null || ntpReach != null) && (
        <section className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            NTP
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <Detail
              label="Offset"
              value={ntpOffset != null ? String(ntpOffset) : null}
              mono
            />
            <Detail
              label="Reach"
              value={ntpReach != null ? String(ntpReach) : null}
              mono
            />
          </dl>
        </section>
      )}
    </>
  );
}


// Row-level Start/Stop button. State derives from the last polled
// radioActivity field in last_status:
//   * "active"        → red Stop  button
//   * anything else   → green Start button (covers "inactive", missing
//                        status, unknown — we let the operator try)
// Hidden for disabled readers (config stubs that aren't being polled).
function ControlButton({
  reader,
  busy,
  onAction,
}: {
  reader: Reader;
  busy: boolean;
  onAction: (verb: "start" | "stop") => void;
}) {
  if (!reader.enabled) return null;
  const activity =
    reader.last_status?.radioActivity ?? reader.last_status?.radioActivitiy;
  const running = String(activity ?? "").toLowerCase() === "active";

  if (running) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onAction("stop")}
        className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
        title="Stop reading tags (PUT /cloud/stop)"
      >
        {busy ? "Stopping…" : "Stop"}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onAction("start")}
      className="rounded-md border border-green-200 bg-white px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-60"
      title="Start reading tags (PUT /cloud/start, doNotPersistState=true)"
    >
      {busy ? "Starting…" : "Start"}
    </button>
  );
}


function Detail({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-400">{label}</dt>
      <dd
        className={`mt-0.5 text-sm break-all ${
          mono ? "font-mono text-xs" : ""
        } ${className ?? "text-zinc-800"}`}
      >
        {value || "—"}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// presentation helpers
// ---------------------------------------------------------------------------

// Four confirmed states derived from the last polled /cloud/status:
//   * Offline – we couldn't reach the reader at the TCP/HTTP transport
//               layer (connection refused, timeout, DNS, etc.) — OR we
//               have never polled successfully.
//   * Error   – the reader responded but with a non-2xx / unparseable
//               response. Wrong password, JWT issues, unexpected body,
//               etc. The reader is alive at the network layer; something
//               is wrong at the API layer.
//   * Reading – /cloud/status succeeded AND radioActivity === "active".
//   * Online  – /cloud/status succeeded AND radio is idle.
//
// Transport vs. HTTP-error is inferred from the canonical error-string
// prefixes the script emits: "login transport error:" / "status transport
// error:" → Offline; anything else with `last_error` set → Error.
function isTransportError(err: string | null | undefined): boolean {
  if (!err) return false;
  const lower = err.toLowerCase();
  return (
    lower.includes("transport error") ||
    lower.includes("connectionerror") ||
    lower.includes("connecttimeout") ||
    lower.includes("readtimeout") ||
    lower.includes("connection refused")
  );
}

function StatusBadge({ reader }: { reader: Reader }) {
  const hasError = !!reader.last_error;
  const hasStatus = !!reader.last_status_at && !!reader.last_status;
  const activity =
    reader.last_status?.radioActivity ?? reader.last_status?.radioActivitiy;
  const reading = String(activity ?? "").toLowerCase() === "active";

  let label: "Offline" | "Online" | "Reading" | "Error";
  let cls: string;
  if (hasError) {
    if (isTransportError(reader.last_error)) {
      label = "Offline";
      cls = "bg-red-50 text-red-700";
    } else {
      label = "Error";
      cls = "bg-amber-50 text-amber-700";
    }
  } else if (!hasStatus) {
    label = "Offline";
    cls = "bg-red-50 text-red-700";
  } else if (reading) {
    label = "Reading";
    cls = "bg-blue-50 text-blue-700";
  } else {
    label = "Online";
    cls = "bg-green-50 text-green-700";
  }

  return (
    <span
      title={reader.last_error ?? undefined}
      className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Add Reader modal
// ---------------------------------------------------------------------------

type ReaderForm = {
  name: string;
  reader_type: string;
  scheme: "http" | "https";
  address: string;
  port: string;
  antennas: string;
  admin_username: string;
  admin_password: string;
  notes: string;
  production_method: OutputMethod;
  production_url: string;
  local_method: OutputMethod;
  local_url: string;
};

const METHOD_OPTIONS: { value: OutputMethod; label: string }[] = [
  { value: "api", label: "API" },
  { value: "mqtt", label: "MQTT" },
  { value: "disable", label: "Disable" },
];

// FastAPI binds 8000; readers POST tag events directly to it. (The portal
// runs as a separate process on :80 — different port, same Pi.)
const API_PORT = 8000;
const LOCAL_INGEST_PATH = "/rfid-tags";

async function fetchPiLanIp(): Promise<string | null> {
  try {
    const res = await fetch("/local/settings", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      connections?: Array<{ type?: string; ip4?: string }>;
    };
    const conn = (data.connections ?? []).find(
      (c) => c?.type !== "loopback" && c?.ip4
    );
    return conn?.ip4 ?? null;
  } catch {
    return null;
  }
}

type ScanResult = {
  subnet: string;
  scanned_count: number;
  responded: Array<{ ip: string; port: number }>;
  took_seconds: number;
};

function emptyForm(model: ModelDef): ReaderForm {
  return {
    name: "",
    reader_type: model.value,
    scheme: model.scheme,
    address: "",
    port: String(model.port),
    antennas: String(model.antennas),
    admin_username: "admin",
    admin_password: "",
    notes: "",
    production_method: "api",
    production_url: "",
    local_method: "api",
    local_url: "",
  };
}

function AddReaderModal({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (f: ReaderForm) => void;
}) {
  const [form, setForm] = useState<ReaderForm>(() => emptyForm(DEFAULT_MODEL));
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);

  const canSubmit = form.name.trim() && form.address.trim() && !busy;

  function onModelChange(value: string) {
    const m = MODELS.find((x) => x.value === value) ?? DEFAULT_MODEL;
    setForm((f) => ({
      ...f,
      reader_type: m.value,
      scheme: m.scheme,
      port: String(m.port),
      antennas: String(m.antennas),
    }));
  }

  async function startScan() {
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    try {
      const res = await fetch("/local/rfid/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: Number(form.port) || 443 }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) setScanResult(body as ScanResult);
      else setScanError(body?.detail ?? "Scan failed.");
    } catch (e) {
      setScanError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  function pickIp(ip: string) {
    setForm((f) => ({ ...f, address: ip }));
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Add a new RFID reader</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Default model is Zebra FX9600 — communicates via the IoT Connector
          REST API on HTTPS:443. Use Scan to find readers on this subnet, or
          enter the IP manually.
        </p>

        <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Find readers automatically
            </p>
            <button
              type="button"
              onClick={startScan}
              disabled={scanning || busy}
              className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:bg-zinc-400"
            >
              {scanning
                ? "Scanning…"
                : `Scan port ${form.port || "443"} on local subnet`}
            </button>
          </div>
          {scanError && <p className="mt-2 text-xs text-red-700">{scanError}</p>}
          {scanResult && (
            <div className="mt-3 text-xs text-zinc-600">
              <p className="text-zinc-500">
                Scanned <span className="font-mono">{scanResult.subnet}</span>{" "}
                ({scanResult.scanned_count} hosts) in{" "}
                {scanResult.took_seconds}s — {scanResult.responded.length}{" "}
                responded.
              </p>
              {scanResult.responded.length === 0 ? (
                <p className="mt-1 italic text-zinc-400">
                  No reader-shaped hosts found on this port.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-zinc-200 overflow-hidden rounded border border-zinc-200 bg-white">
                  {scanResult.responded.map((r) => (
                    <li
                      key={r.ip}
                      className="flex items-center justify-between px-3 py-1.5"
                    >
                      <span className="font-mono text-zinc-800">
                        {r.ip}
                        <span className="ml-1 text-zinc-400">:{r.port}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => pickIp(r.ip)}
                        className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        Use this
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            required
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
            placeholder="Dock 1 Reader"
          />

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Model
            </span>
            <select
              value={form.reader_type || DEFAULT_MODEL.value}
              onChange={(e) => onModelChange(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Scheme
            </span>
            <select
              value={form.scheme}
              onChange={(e) =>
                setForm({ ...form, scheme: e.target.value as "http" | "https" })
              }
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
            >
              <option value="http">http://</option>
              <option value="https">https:// (verify=False)</option>
            </select>
          </label>
          <Field
            label="Address"
            required
            mono
            value={form.address}
            onChange={(v) => setForm({ ...form, address: v })}
            placeholder="10.10.48.50"
          />
          <Field
            label="Port"
            mono
            value={form.port}
            onChange={(v) => setForm({ ...form, port: v })}
            placeholder={form.scheme === "https" ? "443" : "80"}
          />
          <Field
            label="Antennas"
            value={form.antennas}
            onChange={(v) => setForm({ ...form, antennas: v })}
            placeholder="4"
          />
          <Field
            label="Admin username"
            value={form.admin_username}
            onChange={(v) => setForm({ ...form, admin_username: v })}
            placeholder="admin"
          />

          <label className="block sm:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Admin password
            </span>
            <div className="mt-1 flex gap-2">
              <input
                type={showPw ? "text" : "password"}
                value={form.admin_password}
                onChange={(e) =>
                  setForm({ ...form, admin_password: e.target.value })
                }
                placeholder="Reader admin password"
                className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <EventDeliverySection form={form} setForm={setForm} />

          <div className="sm:col-span-2">
            <Field
              label="Notes"
              value={form.notes}
              onChange={(v) => setForm({ ...form, notes: v })}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(form)}
            disabled={!canSubmit}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"
          >
            {busy ? "Saving…" : "Add reader"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EventDeliverySection({
  form,
  setForm,
}: {
  form: ReaderForm;
  setForm: React.Dispatch<React.SetStateAction<ReaderForm>>;
}) {
  return (
    <div className="sm:col-span-2 mt-1 rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Event delivery
      </p>
      <p className="mt-1 text-[11px] text-zinc-500">
        Where the reader ships tag + management events. Production usually
        targets BaseCamp; Local targets this Pi.
      </p>
      {/* Methods — short dropdowns side-by-side */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Production method
          </span>
          <select
            value={form.production_method}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                production_method: e.target.value as OutputMethod,
              }))
            }
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
          >
            {METHOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Local method
          </span>
          <select
            value={form.local_method}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                local_method: e.target.value as OutputMethod,
              }))
            }
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
          >
            {METHOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* URLs — full width so the button has room */}
      <div className="mt-3 space-y-3">
        <Field
          label="Production URL"
          mono
          value={form.production_url}
          onChange={(v) => setForm((f) => ({ ...f, production_url: v }))}
          placeholder={
            form.production_method === "mqtt"
              ? "mqtts://broker.example.com:8883/rfid"
              : "https://api.example.com/rfid/events"
          }
        />

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Local URL
          </span>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={form.local_url}
              onChange={(e) =>
                setForm((f) => ({ ...f, local_url: e.target.value }))
              }
              placeholder={
                form.local_method === "mqtt"
                  ? "mqtt://localhost:1883/rfid"
                  : `http://<pi-ip>:${API_PORT}${LOCAL_INGEST_PATH}`
              }
              className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={async () => {
                const ip = await fetchPiLanIp();
                if (ip) {
                  setForm((f) => ({
                    ...f,
                    local_url: `http://${ip}:${API_PORT}${LOCAL_INGEST_PATH}`,
                  }));
                }
              }}
              title={`Insert http://<this Pi's LAN IP>:${API_PORT}${LOCAL_INGEST_PATH}`}
              className="whitespace-nowrap rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Use Pi IP
            </button>
          </div>
        </label>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
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
  accent?: "green" | "red" | "zinc";
}) {
  const valueCls =
    accent === "green"
      ? "text-green-700"
      : accent === "red"
        ? "text-red-700"
        : "text-zinc-900";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <p className="text-xs uppercase tracking-widest text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueCls}`}>{value}</p>
      {subtitle && (
        <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
      )}
    </div>
  );
}
