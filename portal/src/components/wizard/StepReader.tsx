"use client";

import { useEffect, useRef, useState } from "react";
import { EthernetPort, Plus, RotateCw, Check, Loader2 } from "lucide-react";
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

type DiscoveredReader = {
  ip: string;
  scheme: string;
  port: number;
  name: string | null;
  source: string;
  confirmed: boolean;
  cred_index: number | null;
};

function isOnline(r: Reader): boolean {
  return !r.last_error && r.last_status != null;
}

// Where the reader's IoT-Connector ships tag reads. Initial setup ensures the
// selected reader's data endpoint points back at this Pi.
const API_PORT = 8000;
const INGEST_PATH = "/rfid-tags";

type EpConfig = {
  data?: { event?: { connections?: Array<{ type?: string; options?: { URL?: string } }> } };
};

function httpPostUrl(ep: EpConfig | null | undefined): string | null {
  const conns = ep?.data?.event?.connections;
  if (!Array.isArray(conns)) return null;
  return conns.find((x) => x?.type === "httpPost")?.options?.URL ?? null;
}

type EpPhase = "idle" | "checking" | "setting" | "verifying" | "verified" | "error";

export function StepReader({ state, update }: StepProps) {
  const [readers, setReaders] = useState<Reader[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [epPhase, setEpPhase] = useState<EpPhase>(
    state.readerName && state.endpointVerified ? "verified" : "idle"
  );
  const [epMsg, setEpMsg] = useState<string | null>(null);
  const [epUrl, setEpUrl] = useState<string | null>(null);
  const mounted = useRef(true);

  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredReader[]>([]);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [busyAdopt, setBusyAdopt] = useState<string | null>(null);
  const [prefillIp, setPrefillIp] = useState("");

  async function scanForReaders() {
    setScanning(true);
    setScanErr(null);
    try {
      const r = await fetch("/local/rfid/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const b = (await r.json().catch(() => null)) as
        | { readers?: DiscoveredReader[]; detail?: string }
        | null;
      if (r.ok && b) setDiscovered(b.readers ?? []);
      else setScanErr(b?.detail ?? "Scan failed.");
    } catch {
      setScanErr("Scan failed.");
    } finally {
      setScanning(false);
    }
  }

  async function adoptDiscovered(d: DiscoveredReader) {
    if (d.cred_index == null) {
      setPrefillIp(d.ip);
      setAdding(true);
      return;
    }
    setBusyAdopt(d.ip);
    setScanErr(null);
    try {
      const r = await fetch("/local/rfid/readers/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: d.ip, scheme: d.scheme, cred_index: d.cred_index }),
      });
      const b = (await r.json().catch(() => null)) as { detail?: string } | null;
      if (!r.ok) {
        setScanErr(b?.detail ?? "Could not add reader.");
        return;
      }
      setDiscovered((xs) => xs.filter((x) => x.ip !== d.ip));
      const list = await refresh();
      const added = list.find((x) => x.address === d.ip);
      if (added && isOnline(added)) select(added);
      else if (added) update({ readerName: added.name, endpointVerified: false });
    } catch {
      setScanErr("Could not add reader.");
    } finally {
      setBusyAdopt(null);
    }
  }

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  async function load(): Promise<Reader[]> {
    try {
      const r = await fetch("/local/rfid/readers", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as { readers?: Reader[] };
        const list = d.readers ?? [];
        setReaders(list);
        return list;
      }
    } catch {
      /* keep last */
    }
    return readers;
  }

  async function refresh(): Promise<Reader[]> {
    setLoading(true);
    try {
      await fetch("/local/rfid/readers/poll-status", { method: "POST" });
      return await load();
    } catch {
      return readers;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- endpoint check / set / verify ---------------------------------------

  async function piUrl(): Promise<string | null> {
    try {
      const r = await fetch("/local/settings", { cache: "no-store" });
      if (!r.ok) return null;
      const d = (await r.json()) as { connections?: Array<{ type?: string; ip4?: string }> };
      const conn = (d.connections ?? []).find((c) => c?.type !== "loopback" && c?.ip4);
      return conn?.ip4 ? `http://${conn.ip4}:${API_PORT}${INGEST_PATH}` : null;
    } catch {
      return null;
    }
  }

  async function getEndpoint(id: number): Promise<{ ep?: EpConfig | null; error?: string }> {
    try {
      const r = await fetch(`/local/rfid/readers/${id}/endpoint-config`, { cache: "no-store" });
      const b = (await r.json().catch(() => null)) as
        | { endpoint_config?: EpConfig | null; detail?: string }
        | null;
      if (!r.ok) return { error: b?.detail ?? `HTTP ${r.status}` };
      return { ep: b?.endpoint_config ?? null };
    } catch {
      return { error: "Could not reach the API." };
    }
  }

  async function putEndpointUrl(id: number, url: string): Promise<{ error?: string }> {
    try {
      const r = await fetch(`/local/rfid/readers/${id}/endpoint-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (r.ok) return {};
      const b = (await r.json().catch(() => null)) as { detail?: string } | null;
      return { error: b?.detail ?? `HTTP ${r.status}` };
    } catch {
      return { error: "Could not reach the API." };
    }
  }

  // Check the reader's current endpoint, set it to this Pi if it differs, then
  // re-read to verify. Sets endpointVerified (gates the wizard's Next) on
  // success; any failure leaves it false and shows the error + a Retry.
  async function pointAtPi(reader: Reader) {
    setEpMsg(null);
    setEpPhase("checking");
    const url = await piUrl();
    if (!mounted.current) return;
    if (!url) {
      setEpPhase("error");
      setEpMsg("Couldn’t determine this Pi’s IP address.");
      return;
    }
    setEpUrl(url);

    const cur = await getEndpoint(reader.id);
    if (!mounted.current) return;
    if (cur.error) {
      setEpPhase("error");
      setEpMsg(cur.error);
      return;
    }

    if (httpPostUrl(cur.ep) !== url) {
      setEpPhase("setting");
      const res = await putEndpointUrl(reader.id, url);
      if (!mounted.current) return;
      if (res.error) {
        setEpPhase("error");
        setEpMsg(res.error);
        return;
      }
      setEpPhase("verifying");
      const after = await getEndpoint(reader.id);
      if (!mounted.current) return;
      if (after.error) {
        setEpPhase("error");
        setEpMsg(after.error);
        return;
      }
      if (httpPostUrl(after.ep) !== url) {
        setEpPhase("error");
        setEpMsg("Reader didn’t report the new endpoint after setting.");
        return;
      }
    }

    setEpPhase("verified");
    update({ endpointVerified: true });
  }

  function select(r: Reader) {
    if (!isOnline(r)) return;
    update({ readerName: r.name, endpointVerified: false });
    setEpUrl(null);
    pointAtPi(r);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <LoadingOverlay show={loading} label="Checking readers…" />
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Connected readers
        </p>
        <button
          type="button"
          onClick={scanForReaders}
          disabled={scanning}
          className="ml-auto flex h-8 items-center gap-1.5 rounded-lg border border-blue-800 bg-blue-950/40 px-3 text-xs text-blue-200 disabled:opacity-50"
        >
          <RotateCw className={"h-3.5 w-3.5 " + (scanning ? "animate-spin" : "")} />
          {scanning ? "Scanning..." : "Scan for readers"}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-300 disabled:opacity-50"
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
        {scanErr && <p className="text-xs text-red-400">{scanErr}</p>}
        {discovered
          .filter((d) => !readers.some((r) => r.address === d.ip))
          .map((d) => (
            <button
              key={d.ip}
              type="button"
              onClick={() => adoptDiscovered(d)}
              disabled={busyAdopt === d.ip}
              className="flex items-center gap-3 rounded-xl border border-blue-900 bg-blue-950/30 px-4 py-3 text-left disabled:opacity-60"
            >
              <EthernetPort className="h-5 w-5 text-zinc-400" aria-hidden />
              <div>
                <div className="text-zinc-100">{d.name ?? d.ip}</div>
                <div className="font-mono text-xs text-zinc-500">
                  {d.ip}
                  <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                    {d.scheme}
                  </span>
                </div>
              </div>
              <span className="ml-auto text-xs font-semibold text-blue-300">
                {busyAdopt === d.ip
                  ? "Adding..."
                  : d.cred_index == null
                    ? "Add manually"
                    : "Add"}
              </span>
            </button>
          ))}
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 px-4 py-3 text-sm text-blue-300"
        >
          <Plus className="h-4 w-4" /> Add reader
        </button>
      </div>

      {state.readerName && epPhase !== "idle" && (
        <div
          className={
            "flex-none rounded-xl border px-4 py-3 text-sm " +
            (epPhase === "verified"
              ? "border-green-700 bg-green-950/40 text-green-300"
              : epPhase === "error"
                ? "border-red-700 bg-red-950/40 text-red-300"
                : "border-zinc-700 bg-zinc-900 text-zinc-300")
          }
        >
          {epPhase === "checking" && (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking reader endpoint…
            </span>
          )}
          {epPhase === "setting" && (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Pointing reader at this Pi…
            </span>
          )}
          {epPhase === "verifying" && (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
            </span>
          )}
          {epPhase === "verified" && (
            <span>
              ✓ Reader endpoint points at this Pi
              {epUrl ? ` — ${epUrl}` : ""}.
            </span>
          )}
          {epPhase === "error" && (
            <div className="flex items-center justify-between gap-3">
              <span>✗ Couldn’t set the reader endpoint: {epMsg}</span>
              <button
                type="button"
                onClick={() => {
                  const r = readers.find((x) => x.name === state.readerName);
                  if (r) pointAtPi(r);
                }}
                className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-200"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {adding && (
        <AddReaderPanel
          initialIp={prefillIp}
          onClose={() => {
            setAdding(false);
            setPrefillIp("");
          }}
          onAdded={async (name) => {
            setAdding(false);
            setPrefillIp("");
            const list = await refresh();
            const r = list.find((x) => x.name === name);
            if (r && isOnline(r)) select(r);
            else update({ readerName: name, endpointVerified: false });
          }}
        />
      )}
    </div>
  );
}

function AddReaderPanel({
  onClose,
  onAdded,
  initialIp = "",
}: {
  onClose: () => void;
  onAdded: (name: string) => void;
  initialIp?: string;
}) {
  const [ip, setIp] = useState(initialIp);
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
        | { hostname?: string; scheme?: string; detail?: string }
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
          scheme: pb?.scheme ?? "https",
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
          Name is read from the reader’s hostname on connect. admin user defaults to “admin”; scheme is detected automatically (HTTPS, then HTTP).
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
