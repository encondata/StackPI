"use client";

import { useEffect, useState } from "react";

type DBStatus = {
  status: "online" | "offline";
  version?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  size_bytes?: number;
  active_connections?: number;
  max_connections?: number;
};

const POLL_INTERVAL_MS = 5_000;

function fmtBytes(b?: number): string {
  if (b === undefined || b === null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function DBStatusPage() {
  const [data, setData] = useState<DBStatus | null>(null);
  const [showClearModal, setShowClearModal] = useState(false);
  const [banner, setBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/local/db/status", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as DBStatus;
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

  function flash(kind: "success" | "error", text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 5500);
  }

  async function clearRawScans(password: string): Promise<boolean> {
    try {
      const res = await fetch("/local/db/clear-rfid-raw-scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            raw_scans_deleted?: number;
            matches_deleted?: number;
            processed_deleted?: number;
            pending_lost?: number;
          }
        | { detail?: string }
        | null;
      if (res.ok && body && "ok" in body) {
        const b = body as {
          raw_scans_deleted?: number;
          matches_deleted?: number;
          processed_deleted?: number;
          pending_lost?: number;
        };
        const raw = b.raw_scans_deleted ?? 0;
        const matches = b.matches_deleted ?? 0;
        const proc = b.processed_deleted ?? 0;
        const pending = b.pending_lost ?? 0;
        const main =
          `Cleared ${raw.toLocaleString()} raw scan${raw === 1 ? "" : "s"}, ` +
          `${matches.toLocaleString()} match${matches === 1 ? "" : "es"}, ` +
          `${proc.toLocaleString()} upload-queue row${proc === 1 ? "" : "s"}.`;
        const warning =
          pending > 0
            ? ` ${pending.toLocaleString()} un-uploaded row${pending === 1 ? " was" : "s were"} discarded.`
            : "";
        flash("success", main + warning);
        return true;
      }
      const detail = (body as { detail?: string } | null)?.detail;
      flash("error", detail ?? "Failed to clear table.");
      return false;
    } catch {
      flash("error", "Network error.");
      return false;
    }
  }

  const online = data?.status === "online";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">DB Status</h1>
        <p className="text-sm text-zinc-500">
          Live state of the in-memory <code className="font-mono">stackpi</code>{" "}
          PostgreSQL cluster.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          label="Status"
          value={
            data?.status === "online"
              ? "Online"
              : data?.status === "offline"
                ? "Offline"
                : "—"
          }
          subtitle={
            data?.version ? `PostgreSQL ${data.version}` : "checking…"
          }
          accent={online ? "green" : data ? "red" : "zinc"}
        />
        <Card
          label="Connection"
          value={
            data?.host && data?.port ? `${data.host}:${data.port}` : "—"
          }
          subtitle={data?.user ? `as ${data.user}` : undefined}
          mono
        />
        <Card
          label="Database"
          value={data?.database ?? "—"}
          subtitle={
            data?.size_bytes !== undefined
              ? fmtBytes(data.size_bytes)
              : undefined
          }
          mono
        />
        <Card
          label="Active connections"
          value={
            data?.active_connections !== undefined
              ? String(data.active_connections)
              : "—"
          }
          subtitle={
            data?.max_connections
              ? `of ${data.max_connections} max`
              : undefined
          }
        />
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-zinc-600">
          Cluster lives entirely on tmpfs (RAM) with logical snapshots
          (pg_dump -Fc) written to the USB drive every 5 minutes. To browse
          tables, open <strong>DB &rarr; DB Admin</strong> in the sidebar.
        </p>
      </section>

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

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-zinc-900">Maintenance</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Destructive operations on the stackpi database. Each one requires
          a password confirmation.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-900">
              Clear RFID scan pipeline
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
              Empties <code className="font-mono">local_rfid_raw_scans</code>,{" "}
              <code className="font-mono">local_rfid_matches</code>, and{" "}
              <code className="font-mono">local_rfid_processed_scans</code>{" "}
              (the FK chain has to be cleared together) and resets all id
              sequences. Any un-uploaded scans are lost. Cannot be undone.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowClearModal(true)}
            className="self-start rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Clear table
          </button>
        </div>
      </section>

      {showClearModal && (
        <ConfirmPasswordModal
          title="Clear RFID scan pipeline"
          message={
            <>
              This will permanently delete every row in{" "}
              <code className="font-mono">local_rfid_raw_scans</code>,{" "}
              <code className="font-mono">local_rfid_matches</code>, and{" "}
              <code className="font-mono">local_rfid_processed_scans</code>,
              and reset their id sequences. Any un-uploaded scans are
              dropped. Enter the maintenance password to continue.
            </>
          }
          confirmLabel="Clear table"
          onCancel={() => setShowClearModal(false)}
          onConfirm={async (password) => {
            const ok = await clearRawScans(password);
            if (ok) setShowClearModal(false);
            return ok;
          }}
        />
      )}
    </div>
  );
}

function ConfirmPasswordModal({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  // Returns true when the action succeeded — caller decides whether to close.
  onConfirm: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!password) return;
    setBusy(true);
    try {
      await onConfirm(password);
    } finally {
      setBusy(false);
    }
  }

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
        <h3 className="text-lg font-semibold text-zinc-900">{title}</h3>
        <p className="mt-2 text-sm text-zinc-600">{message}</p>
        <div className="mt-4">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
            Password
          </label>
          <input
            type="password"
            autoFocus
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-60"
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !password}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  subtitle,
  accent = "zinc",
  mono = false,
}: {
  label: string;
  value: string;
  subtitle?: string;
  accent?: "green" | "red" | "zinc";
  mono?: boolean;
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
      <p
        className={`mt-1 text-xl font-semibold ${valueCls} ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </p>
      {subtitle && (
        <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
      )}
    </div>
  );
}
