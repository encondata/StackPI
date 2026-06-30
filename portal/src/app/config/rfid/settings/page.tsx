"use client";

import { useEffect, useState } from "react";
import { AlertSettingsSection } from "@/components/settings/AlertSettingsSection";
import { ReaderSiteScanSection } from "@/components/settings/ReaderSiteScanSection";

type RFIDSettings = {
  rfid_polling_refresh_minutes: number;
  rfid_polling_refresh_minutes_default: number;
  rfid_polling_refresh_minutes_min: number;
  rfid_polling_refresh_minutes_max: number;
  rfid_show_unmatched_scans: boolean;
  rfid_show_unmatched_scans_default: boolean;
};

export default function RFIDSettingsPage() {
  const [data, setData] = useState<RFIDSettings | null>(null);
  // Input is a string so the field can hold an empty/typing value mid-edit
  // without the integer logic fighting the user.
  const [input, setInput] = useState<string>("");
  const [showUnmatched, setShowUnmatched] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/local/rfid/settings", { cache: "no-store" });
        if (!cancelled && res.ok) {
          const body = (await res.json()) as RFIDSettings;
          setData(body);
          setInput(String(body.rfid_polling_refresh_minutes));
          setShowUnmatched(Boolean(body.rfid_show_unmatched_scans));
        }
      } catch {
        /* keep current */
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function flash(kind: "success" | "error", text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 5500);
  }

  async function save() {
    if (!data) return;
    const parsed = Number.parseInt(input, 10);
    if (
      !Number.isFinite(parsed) ||
      parsed < data.rfid_polling_refresh_minutes_min ||
      parsed > data.rfid_polling_refresh_minutes_max
    ) {
      flash(
        "error",
        `Enter a whole number between ${data.rfid_polling_refresh_minutes_min} and ${data.rfid_polling_refresh_minutes_max}.`,
      );
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/local/rfid/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rfid_polling_refresh_minutes: parsed,
          rfid_show_unmatched_scans: showUnmatched,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        const fresh = body as RFIDSettings;
        setData(fresh);
        setInput(String(fresh.rfid_polling_refresh_minutes));
        setShowUnmatched(Boolean(fresh.rfid_show_unmatched_scans));
        flash("success", "Settings saved.");
      } else {
        const detail = (body as { detail?: string } | null)?.detail;
        flash("error", detail ?? "Failed to save settings.");
      }
    } finally {
      setBusy(false);
    }
  }

  const dirty =
    data != null &&
    (String(data.rfid_polling_refresh_minutes) !== input.trim() ||
      Boolean(data.rfid_show_unmatched_scans) !== showUnmatched);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">RFID Settings</h1>
        <p className="text-sm text-zinc-500">
          Configuration for the RFID subsystem. Changes take effect on the
          next polling cycle.
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

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Status Polling</h2>
        <p className="mt-1 text-sm text-zinc-500">
          How often the Pi polls each configured reader&apos;s{" "}
          <code className="font-mono">/cloud/status</code> endpoint and
          refreshes its info fields.
        </p>

        <div className="mt-5 flex items-end gap-3">
          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              RFID_Polling_Refresh
            </span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={data?.rfid_polling_refresh_minutes_min ?? 1}
                max={data?.rfid_polling_refresh_minutes_max ?? 1440}
                step={1}
                value={input}
                disabled={busy || !data}
                onChange={(e) => setInput(e.target.value)}
                className="w-28 rounded-md border border-zinc-300 px-3 py-1.5 text-right font-mono text-sm tabular-nums disabled:opacity-60"
              />
              <span className="text-sm text-zinc-600">minutes</span>
            </div>
          </label>
        </div>

        {data && (
          <p className="mt-3 text-xs text-zinc-500">
            Allowed range:{" "}
            <span className="font-mono">
              {data.rfid_polling_refresh_minutes_min}
            </span>
            –
            <span className="font-mono">
              {data.rfid_polling_refresh_minutes_max}
            </span>{" "}
            minutes. Default:{" "}
            <span className="font-mono">
              {data.rfid_polling_refresh_minutes_default}
            </span>
            .
          </p>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">RFID Activity Display</h2>
        <p className="mt-1 text-sm text-zinc-500">
          The /status kiosk page&apos;s RFID Activity pane shows resolved
          matches (assets and people) by default. Enable this to also show
          raw reads that didn&apos;t match any source — useful when
          provisioning new tags or debugging missing assets.
        </p>

        <label className="mt-4 inline-flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            disabled={busy || !data}
            checked={showUnmatched}
            onChange={(e) => setShowUnmatched(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500 disabled:opacity-60"
          />
          <span className="text-sm text-zinc-800">
            Show unmatched scans on /status
          </span>
        </label>

        {data && (
          <p className="mt-3 text-xs text-zinc-500">
            Default:{" "}
            <span className="font-mono">
              {data.rfid_show_unmatched_scans_default ? "on" : "off"}
            </span>
            .
          </p>
        )}
      </section>

      <ReaderSiteScanSection />
      <AlertSettingsSection />

      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty || !data}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Apply"}
        </button>
      </div>
    </div>
  );
}
