"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

type LocalStatus = {
  status?: "pre_registered" | "registered" | "revoked" | "unknown";
  device_uuid?: string | null;
  hardware_serial?: string | null;
  name?: string | null;
  pairing_token?: string | null;
  pairing_token_expires_at?: string | null;
  link_url?: string | null;
  last_seen_at?: string | null;
  updated_at?: string | null;
};

type Banner = { kind: "success" | "error"; text: string };

const POLL_INTERVAL_MS = 5_000;
const BANNER_LIFETIME_MS = 6_000;

const STATUS_BADGES: Record<string, { label: string; fg: string; bg: string }> = {
  registered: { label: "Registered", fg: "#389e0d", bg: "#f6ffed" },
  pre_registered: { label: "Awaiting pairing", fg: "#096dd9", bg: "#e6f7ff" },
  revoked: { label: "De-registered", fg: "#cf1322", bg: "#fff1f0" },
  unknown: { label: "Unknown", fg: "#595959", bg: "#f5f5f5" },
};

async function fetchStatus(): Promise<LocalStatus> {
  const res = await fetch("/local/status", { cache: "no-store" });
  if (!res.ok) return { status: "unknown" };
  return (await res.json()) as LocalStatus;
}

async function postJSON(path: string): Promise<{ ok: boolean; body: unknown }> {
  try {
    const res = await fetch(path, { method: "POST", cache: "no-store" });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

async function getJSON(path: string): Promise<{ ok: boolean; body: unknown }> {
  try {
    const res = await fetch(path, { cache: "no-store" });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

export default function RegistrationPage() {
  const [data, setData] = useState<LocalStatus | null>(null);
  const [busy, setBusy] = useState<null | "repair" | "deregister" | "diagnostics">(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [confirmDeregister, setConfirmDeregister] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const s = await fetchStatus();
        if (!cancelled) setData(s);
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

  function flash(kind: Banner["kind"], text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), BANNER_LIFETIME_MS);
  }

  async function onForceRepair() {
    if (
      !window.confirm(
        "Force a fresh pairing? The current session will be revoked. The kiosk screen will show a new pairing code within ~30s."
      )
    )
      return;
    setBusy("repair");
    const r = await postJSON("/local/reset-pairing");
    setBusy(null);
    if (r.ok) {
      flash("success", "Re-pairing triggered. Watch the kiosk for the new token.");
    } else {
      flash("error", "Force re-pair failed — see engine logs.");
    }
  }

  async function onDeregister() {
    setBusy("deregister");
    const r = await postJSON("/local/deregister");
    setBusy(null);
    setConfirmDeregister(false);
    if (r.ok) {
      flash("success", "De-registered. Device disconnected from BaseCamp.");
    } else {
      flash("error", "De-register failed — see engine logs.");
    }
  }

  async function onCopyDiagnostics() {
    setBusy("diagnostics");
    const r = await getJSON("/local/diagnostics");
    setBusy(null);
    if (!r.ok || !r.body) {
      flash("error", "Couldn't fetch diagnostics.");
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(r.body, null, 2));
      flash("success", "Diagnostics copied to clipboard.");
    } catch {
      flash(
        "error",
        "Clipboard write failed (requires HTTPS or localhost in most browsers)."
      );
    }
  }

  const status = data?.status ?? "unknown";
  const badge = STATUS_BADGES[status] ?? STATUS_BADGES.unknown;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">StackPI Registration</h1>
        <p className="text-sm text-zinc-500">
          Live pairing state of this device with the BaseCamp API.
        </p>
      </header>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-400">Status</p>
            <p className="mt-1 text-lg font-semibold">{badge.label}</p>
          </div>
          <span
            className="rounded-full px-3 py-1 font-mono text-xs font-semibold uppercase tracking-wide"
            style={{ color: badge.fg, backgroundColor: badge.bg }}
          >
            {status}
          </span>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Device</h2>
        <dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <Field label="Name" value={data?.name} />
          <Field
            label="Last heartbeat"
            value={
              data?.last_seen_at
                ? new Date(data.last_seen_at).toLocaleString()
                : "—"
            }
          />
          <Field label="Device UUID" value={data?.device_uuid} mono />
          <Field label="Hardware serial" value={data?.hardware_serial} mono />
        </dl>
      </section>

      {status === "pre_registered" && data?.pairing_token && (
        <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold">Pairing</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Complete pairing in the BaseCamp portal at /rfid/stackpi-devices,
            or scan the QR.
          </p>
          <div className="mt-4 flex flex-col items-start gap-6 sm:flex-row sm:items-center">
            {data.link_url && (
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <QRCodeSVG value={data.link_url} size={160} />
              </div>
            )}
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-widest text-zinc-400">
                Pairing token
              </p>
              <p className="font-mono text-4xl font-bold tracking-[0.15em] text-zinc-900">
                {data.pairing_token}
              </p>
              {data.pairing_token_expires_at && (
                <p className="text-xs text-zinc-500">
                  Expires{" "}
                  {new Date(data.pairing_token_expires_at).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Actions</h2>

        {banner && (
          <div
            role="status"
            className={`mt-4 rounded-md border px-3 py-2 text-sm ${
              banner.kind === "success"
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {banner.text}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onForceRepair}
            disabled={busy !== null || status !== "registered"}
            title={
              status !== "registered"
                ? "Only available while registered"
                : "Revoke and re-pair using the same identity"
            }
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:border-zinc-100 disabled:text-zinc-400"
          >
            {busy === "repair" ? "Working…" : "Force re-pair"}
          </button>

          <button
            type="button"
            onClick={() => setConfirmDeregister(true)}
            disabled={busy !== null || status !== "registered"}
            title={
              status !== "registered"
                ? "Only available while registered"
                : "Tell BaseCamp this Pi is leaving"
            }
            className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-zinc-100 disabled:text-zinc-400"
          >
            De-register
          </button>

          <button
            type="button"
            onClick={onCopyDiagnostics}
            disabled={busy !== null}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
          >
            {busy === "diagnostics" ? "Copying…" : "Copy diagnostics"}
          </button>
        </div>
      </section>

      {confirmDeregister && (
        <DeregisterModal
          busy={busy === "deregister"}
          onCancel={() => setConfirmDeregister(false)}
          onConfirm={onDeregister}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-400">{label}</dt>
      <dd
        className={`mt-1 break-all ${
          mono ? "font-mono text-xs" : "text-sm"
        } text-zinc-800`}
      >
        {value || "—"}
      </dd>
    </div>
  );
}

function DeregisterModal({
  busy,
  onCancel,
  onConfirm,
}: {
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
        <h3 className="text-lg font-semibold text-red-700">De-register this device?</h3>
        <p className="mt-3 text-sm text-zinc-700">
          This will tell BaseCamp to revoke the current pairing and clear the
          device's local identity. The PITFT50 will return to the pairing
          screen with a fresh token.
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          The agent will re-init immediately. To keep the device offline, an
          admin should remove or leave the row revoked in the BaseCamp portal.
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
            {busy ? "De-registering…" : "Yes, de-register"}
          </button>
        </div>
      </div>
    </div>
  );
}
