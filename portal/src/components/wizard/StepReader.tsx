"use client";

import { useEffect, useState } from "react";
import { EthernetPort, Plus, RotateCw, Check } from "lucide-react";
import { OnScreenKeyboard } from "@/components/OnScreenKeyboard";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import type { StepProps } from "./InitialSetupWizard";

type Reader = {
  id: number;
  name: string;
  address: string;
  last_status: unknown | null;
  last_error: string | null;
};

function isOnline(r: Reader): boolean {
  return !r.last_error && r.last_status != null;
}

export function StepReader({ state, update }: StepProps) {
  const [readers, setReaders] = useState<Reader[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  async function load() {
    try {
      const r = await fetch("/local/rfid/readers", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as { readers?: Reader[] };
        setReaders(d.readers ?? []);
      }
    } catch {
      /* keep last */
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      await fetch("/local/rfid/readers/poll-status", { method: "POST" });
      await load();
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(r: Reader) {
    if (!isOnline(r)) return;
    update({ readerName: r.name });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <LoadingOverlay show={loading} label="Checking readers…" />
      <div className="flex items-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Connected readers
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="ml-auto flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-300 disabled:opacity-50"
        >
          <RotateCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
          Recheck
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {readers.length === 0 && !loading && (
          <p className="text-sm text-zinc-500">
            No readers configured. Add one below.
          </p>
        )}
        {readers.map((r) => {
          const online = isOnline(r);
          const selected = state.readerName === r.name;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => select(r)}
              disabled={!online}
              className={
                "flex items-center gap-3 rounded-xl border px-4 py-3 text-left " +
                (selected
                  ? "border-green-600 bg-green-950/40 "
                  : "border-zinc-800 bg-zinc-900 ") +
                (!online ? "opacity-60" : "")
              }
            >
              <EthernetPort className="h-5 w-5 text-zinc-400" aria-hidden />
              <div>
                <div className="text-zinc-100">{r.name}</div>
                <div className="font-mono text-xs text-zinc-500">{r.address}</div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span
                  className={
                    "text-xs font-semibold " +
                    (online ? "text-green-400" : "text-red-400")
                  }
                >
                  ● {online ? "Online" : "Unreachable"}
                </span>
                {selected && <Check className="h-5 w-5 text-green-400" />}
              </div>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 px-4 py-3 text-sm text-blue-300"
        >
          <Plus className="h-4 w-4" /> Add reader
        </button>
      </div>

      {adding && (
        <AddReaderPanel
          onClose={() => setAdding(false)}
          onAdded={async (name) => {
            setAdding(false);
            await refresh();
            update({ readerName: name });
          }}
        />
      )}
    </div>
  );
}

function AddReaderPanel({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const [ip, setIp] = useState("");
  const [pw, setPw] = useState("");
  const [field, setField] = useState<"ip" | "pw">("ip");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    if (busy || !ip) return;
    setBusy(true);
    setError(null);
    try {
      const pr = await fetch("/local/rfid/readers/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ip, password: pw }),
      });
      const pb = (await pr.json().catch(() => null)) as
        | { hostname?: string; detail?: string }
        | null;
      if (!pr.ok) {
        setError(pb?.detail ?? "Could not reach reader.");
        return;
      }
      const hostname = pb?.hostname || ip;
      const cr = await fetch("/local/rfid/readers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: hostname,
          address: ip,
          admin_password: pw,
          scheme: "https",
        }),
      });
      if (!cr.ok) {
        const cb = (await cr.json().catch(() => null)) as { detail?: string } | null;
        setError(cb?.detail ?? "Failed to add reader.");
        return;
      }
      onAdded(hostname);
    } catch {
      setError("Could not reach reader.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex items-end bg-black/55" onClick={onClose}>
      <div
        className="w-full rounded-t-2xl border-t border-zinc-800 bg-zinc-950 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-3 text-base font-semibold">Add Reader</p>
        <div className="mb-3 flex gap-3">
          <button
            type="button"
            onClick={() => setField("ip")}
            className={
              "flex-1 rounded-lg border px-3 py-2 text-left " +
              (field === "ip" ? "border-blue-500 bg-zinc-900" : "border-zinc-700 bg-zinc-900")
            }
          >
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Reader IP</div>
            <div className="font-mono text-base text-zinc-100">{ip || " "}</div>
          </button>
          <button
            type="button"
            onClick={() => setField("pw")}
            className={
              "flex-1 rounded-lg border px-3 py-2 text-left " +
              (field === "pw" ? "border-blue-500 bg-zinc-900" : "border-zinc-700 bg-zinc-900")
            }
          >
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Password</div>
            <div className="font-mono text-base text-zinc-100">
              {pw ? "•".repeat(pw.length) : " "}
            </div>
          </button>
        </div>
        <p className="mb-2 text-[11px] text-zinc-500">
          Name is read from the reader’s hostname on connect. admin user defaults to “admin”; https:443.
        </p>
        {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
        <div className="mb-3">
          {field === "ip" ? (
            <OnScreenKeyboard layout="numeric" value={ip} onChange={setIp} />
          ) : (
            <OnScreenKeyboard layout="full" value={pw} onChange={setPw} onEnter={connect} />
          )}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={connect}
            disabled={busy || !ip}
            className="ml-auto rounded-lg bg-green-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
