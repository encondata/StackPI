"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  TriangleAlert,
  Lock,
  LockOpen,
  Wifi,
  EthernetPort,
  Check,
} from "lucide-react";
import { OnScreenKeyboard } from "@/components/OnScreenKeyboard";

// ---- Shapes (mirror the Phase 1 backend endpoints) ----------------------

type WifiNetwork = {
  in_use: boolean;
  ssid: string;
  signal: number;
  security: string;
};

type Wired = {
  connection: string | null;
  device: string | null;
  carrier: boolean;
  method: "auto" | "manual";
  ip: string | null;
  prefix: number | null;
  gateway: string | null;
  dns: string[];
};

const WIRED_REFRESH_MS = 10_000;
const WIFI_REFRESH_MS = 15_000;

function isOpen(security: string): boolean {
  return security === "" || security === "--";
}

// ---- Page ---------------------------------------------------------------

export function KioskInternet({
  mode,
}: {
  mode: "standalone" | "onboarding";
}) {
  const [wired, setWired] = useState<Wired | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [wifiScanned, setWifiScanned] = useState(false);

  // Panels: only one open at a time.
  const [wifiTarget, setWifiTarget] = useState<string | null>(null);
  const [wiredOpen, setWiredOpen] = useState(false);

  // Inline connect state for tapping an open network directly.
  const [connectingSsid, setConnectingSsid] = useState<string | null>(null);

  // Clock for the status bar.
  const [time, setTime] = useState("");
  const [dateStr, setDateStr] = useState("");
  const [host, setHost] = useState("…");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(
        d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
      );
      setDateStr(
        d.toLocaleDateString([], {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/settings", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const d = (await r.json()) as { hostname?: string };
          if (d?.hostname) setHost(d.hostname);
        }
      } catch {
        /* keep last value */
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshWired() {
    try {
      const r = await fetch("/local/settings/wired", { cache: "no-store" });
      if (!r.ok) return;
      const d = (await r.json()) as Wired;
      setWired(d);
    } catch {
      /* keep last good data */
    }
  }

  async function refreshWifi() {
    try {
      const r = await fetch("/local/settings/wifi/networks", {
        cache: "no-store",
      });
      if (!r.ok) return;
      const d = (await r.json()) as { networks: WifiNetwork[] };
      setNetworks(d.networks ?? []);
    } catch {
      /* keep last good data */
    } finally {
      setWifiScanned(true);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function tickWired() {
      if (cancelled) return;
      await refreshWired();
    }
    tickWired();
    const id = setInterval(tickWired, WIRED_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function tickWifi() {
      if (cancelled) return;
      await refreshWifi();
    }
    tickWifi();
    const id = setInterval(tickWifi, WIFI_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Tap an open network: connect immediately. Secured → open panel.
  async function tapNetwork(n: WifiNetwork) {
    if (n.in_use) return;
    if (!isOpen(n.security)) {
      setWifiTarget(n.ssid);
      return;
    }
    setConnectingSsid(n.ssid);
    try {
      const r = await fetch("/local/settings/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: n.ssid }),
      });
      if (r.ok) {
        await refreshWifi();
        await refreshWired();
      }
    } catch {
      /* surfaced via list state on next poll */
    } finally {
      setConnectingSsid(null);
    }
  }

  return (
    <main className="flex h-screen w-screen flex-col gap-3 overflow-hidden bg-zinc-950 p-4 text-zinc-100">
      <Header mode={mode} />

      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <EthernetRow wired={wired} onOpen={() => setWiredOpen(true)} />

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900">
          {!wifiScanned && networks.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">
              Scanning…
            </p>
          ) : networks.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">
              (no networks detected)
            </p>
          ) : (
            networks.map((n) => (
              <WifiRow
                key={n.ssid}
                network={n}
                connecting={connectingSsid === n.ssid}
                onTap={() => tapNetwork(n)}
              />
            ))
          )}
        </div>
      </section>

      <StatusBar mode={mode} time={time} dateStr={dateStr} host={host} />

      {wifiTarget && (
        <WifiConnectPanel
          ssid={wifiTarget}
          onClose={() => setWifiTarget(null)}
          onConnected={async () => {
            setWifiTarget(null);
            await refreshWifi();
            await refreshWired();
          }}
        />
      )}

      {wiredOpen && wired && (
        <WiredPanel
          wired={wired}
          onClose={() => setWiredOpen(false)}
          onApplied={async () => {
            setWiredOpen(false);
            await refreshWired();
          }}
        />
      )}
    </main>
  );
}

// ---- Header -------------------------------------------------------------

function Header({ mode }: { mode: "standalone" | "onboarding" }) {
  if (mode === "onboarding") {
    return (
      <header className="flex shrink-0 items-center gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Connect to the Internet
        </h1>
        <div className="flex-1" />
        <div className="flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1">
          <TriangleAlert className="h-4 w-4 text-amber-400" aria-hidden />
          <span className="text-xs text-amber-400">
            No internet — needed to register
          </span>
        </div>
      </header>
    );
  }
  return (
    <header className="flex shrink-0 items-center gap-3">
      <Link
        href="/"
        aria-label="Back"
        className="flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300"
      >
        <ArrowLeft className="h-5 w-5" aria-hidden />
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Internet</h1>
    </header>
  );
}

// ---- Ethernet row -------------------------------------------------------

function EthernetRow({
  wired,
  onOpen,
}: {
  wired: Wired | null;
  onOpen: () => void;
}) {
  const connected = !!wired?.carrier;
  const methodLabel =
    wired?.method === "manual" ? "Static" : wired ? "DHCP" : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex shrink-0 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-left"
    >
      <EthernetPort className="h-6 w-6 text-zinc-400" aria-hidden />
      <span className="text-lg font-medium text-zinc-100">Ethernet</span>
      <div className="flex-1" />
      {methodLabel && (
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          {methodLabel}
        </span>
      )}
      {connected ? (
        <span className="text-sm font-medium text-green-400">
          {wired?.ip ? `Connected · ${wired.ip}` : "Connected"}
        </span>
      ) : (
        <span className="text-sm text-zinc-500">Not connected</span>
      )}
    </button>
  );
}

// ---- WiFi row -----------------------------------------------------------

function barsFromSignal(signal: number): number {
  if (signal < 25) return 1;
  if (signal < 50) return 2;
  if (signal < 75) return 3;
  return 4;
}

function SignalBars({ signal }: { signal: number }) {
  const bars = barsFromSignal(signal);
  const heights = ["h-1.5", "h-2.5", "h-3.5", "h-4"];
  return (
    <div className="flex items-end gap-0.5" aria-label={`Signal ${signal}%`}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={
            "w-1 rounded-sm " +
            heights[i] +
            " " +
            (i < bars ? "bg-zinc-200" : "bg-zinc-700")
          }
        />
      ))}
    </div>
  );
}

function WifiRow({
  network,
  connecting,
  onTap,
}: {
  network: WifiNetwork;
  connecting: boolean;
  onTap: () => void;
}) {
  const open = isOpen(network.security);
  return (
    <button
      type="button"
      onClick={onTap}
      disabled={network.in_use || connecting}
      className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3 text-left last:border-b-0 disabled:opacity-90"
    >
      <Wifi className="h-5 w-5 text-zinc-400" aria-hidden />
      <SignalBars signal={network.signal} />
      <span className="ml-1 flex-1 truncate text-base text-zinc-100">
        {network.ssid}
      </span>
      {open ? (
        <LockOpen className="h-4 w-4 text-zinc-500" aria-hidden />
      ) : (
        <Lock className="h-4 w-4 text-zinc-500" aria-hidden />
      )}
      {connecting ? (
        <span className="text-sm text-zinc-400">Connecting…</span>
      ) : network.in_use ? (
        <span className="flex items-center gap-1 text-sm font-medium text-green-400">
          <Check className="h-4 w-4" aria-hidden />
          Connected
        </span>
      ) : null}
    </button>
  );
}

// ---- WiFi connect panel -------------------------------------------------

function WifiConnectPanel({
  ssid,
  onClose,
  onConnected,
}: {
  ssid: string;
  onClose: () => void;
  onConnected: () => void | Promise<void>;
}) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/local/settings/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid, password: pw }),
      });
      const body = await r.json().catch(() => null);
      if (r.ok) {
        await onConnected();
      } else {
        setError(body?.detail ?? "Connection failed.");
      }
    } catch {
      setError("Connection failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay>
      <h2 className="text-lg font-semibold tracking-tight">
        Connect to “{ssid}”
      </h2>
      <div className="mt-3 flex items-center gap-2">
        <div className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-lg tracking-widest text-zinc-100">
          {pw ? "•".repeat(pw.length) : <span className="text-zinc-600">password</span>}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={connect}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-blue-400"
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <div className="mt-3">
        <OnScreenKeyboard
          layout="full"
          value={pw}
          onChange={setPw}
          onEnter={connect}
        />
      </div>
    </Overlay>
  );
}

// ---- Wired panel --------------------------------------------------------

const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isDottedQuad(s: string): boolean {
  const m = DOTTED_QUAD.exec(s.trim());
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

function WiredPanel({
  wired,
  onClose,
  onApplied,
}: {
  wired: Wired;
  onClose: () => void;
  onApplied: () => void | Promise<void>;
}) {
  const [method, setMethod] = useState<"auto" | "manual">(wired.method);
  const [ip, setIp] = useState(wired.ip ?? "");
  const [prefix, setPrefix] = useState(
    wired.prefix != null ? String(wired.prefix) : "",
  );
  const [gateway, setGateway] = useState(wired.gateway ?? "");
  const [dns, setDns] = useState((wired.dns ?? [])[0] ?? "");
  const [focused, setFocused] = useState<
    "ip" | "prefix" | "gateway" | "dns"
  >("ip");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const focusedValue = { ip, prefix, gateway, dns }[focused];
  const setFocusedValue = (next: string) => {
    if (focused === "ip") setIp(next);
    else if (focused === "prefix") setPrefix(next);
    else if (focused === "gateway") setGateway(next);
    else setDns(next);
  };

  async function applyAuto() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/local/settings/wired", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "auto" }),
      });
      const body = await r.json().catch(() => null);
      if (r.ok) await onApplied();
      else setError(body?.detail ?? "Failed to apply.");
    } catch {
      setError("Failed to apply.");
    } finally {
      setBusy(false);
    }
  }

  async function applyManual() {
    if (busy) return;
    const prefixNum = Number(prefix);
    if (!isDottedQuad(ip)) {
      setError("IP address must be a valid dotted quad.");
      return;
    }
    if (!isDottedQuad(gateway)) {
      setError("Gateway must be a valid dotted quad.");
      return;
    }
    if (!Number.isInteger(prefixNum) || prefixNum < 1 || prefixNum > 32) {
      setError("Subnet prefix must be between 1 and 32.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/local/settings/wired", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "manual",
          static: {
            ip: ip.trim(),
            prefix: prefixNum,
            gateway: gateway.trim(),
            dns: dns.trim() ? [dns.trim()] : [],
          },
        }),
      });
      const body = await r.json().catch(() => null);
      if (r.ok) await onApplied();
      else setError(body?.detail ?? "Failed to apply.");
    } catch {
      setError("Failed to apply.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay>
      <div className="flex items-center gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Ethernet</h2>
        <div className="flex overflow-hidden rounded-md border border-zinc-700">
          <button
            type="button"
            onClick={() => setMethod("auto")}
            className={
              "px-4 py-1.5 text-sm font-medium " +
              (method === "auto"
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-300")
            }
          >
            DHCP
          </button>
          <button
            type="button"
            onClick={() => setMethod("manual")}
            className={
              "px-4 py-1.5 text-sm font-medium " +
              (method === "manual"
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-300")
            }
          >
            Static
          </button>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      {method === "auto" ? (
        <div className="mt-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-sm">
            <Lease label="IP Address" value={wired.ip} />
            <Lease label="Subnet Prefix" value={wired.prefix != null ? `/${wired.prefix}` : null} />
            <Lease label="Gateway" value={wired.gateway} />
            <Lease label="DNS" value={(wired.dns ?? []).join(", ") || null} />
          </div>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={applyAuto}
              className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white disabled:bg-blue-400"
            >
              {busy ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex gap-4">
          <div className="flex w-1/2 flex-col gap-2">
            <StaticField
              label="IP Address"
              value={ip}
              active={focused === "ip"}
              onFocus={() => setFocused("ip")}
            />
            <StaticField
              label="Subnet Prefix"
              value={prefix}
              active={focused === "prefix"}
              onFocus={() => setFocused("prefix")}
            />
            <StaticField
              label="Gateway"
              value={gateway}
              active={focused === "gateway"}
              onFocus={() => setFocused("gateway")}
            />
            <StaticField
              label="DNS"
              value={dns}
              active={focused === "dns"}
              onFocus={() => setFocused("dns")}
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={applyManual}
                className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white disabled:bg-blue-400"
              >
                {busy ? "Applying…" : "Save & Apply"}
              </button>
            </div>
          </div>
          <div className="w-1/2">
            <OnScreenKeyboard
              layout="numeric"
              value={focusedValue}
              onChange={setFocusedValue}
            />
          </div>
        </div>
      )}
    </Overlay>
  );
}

function Lease({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </span>
      <span className="text-zinc-100">{value || "—"}</span>
    </div>
  );
}

function StaticField({
  label,
  value,
  active,
  onFocus,
}: {
  label: string;
  value: string;
  active: boolean;
  onFocus: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onFocus}
      className={
        "flex flex-col items-start rounded-md border bg-zinc-900 px-3 py-1.5 text-left " +
        (active ? "border-blue-500" : "border-zinc-700")
      }
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </span>
      <span
        className={
          "font-mono text-base " +
          (active ? "text-blue-300" : "text-zinc-100")
        }
      >
        {value || <span className="text-zinc-600">—</span>}
      </span>
    </button>
  );
}

// ---- Overlay ------------------------------------------------------------

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-end bg-black/55">
      <div className="w-full rounded-t-2xl border-t border-zinc-800 bg-zinc-950 p-4">
        {children}
      </div>
    </div>
  );
}

// ---- Status bar (mirrors KioskHome's HomeStatusBar) ---------------------

function StatusBar({
  mode,
  time,
  dateStr,
  host,
}: {
  mode: "standalone" | "onboarding";
  time: string;
  dateStr: string;
  host: string;
}) {
  return (
    <div className="flex h-[60px] shrink-0 items-center gap-6 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 px-5 font-mono">
      <p className="text-3xl leading-none tabular-nums text-zinc-100">
        {time || "—"}
      </p>
      <p className="text-sm tabular-nums text-zinc-400">{dateStr}</p>
      <div className="flex-1" />
      <div className="flex items-baseline gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
          Host
        </p>
        <p className="text-lg leading-tight text-zinc-100">{host}</p>
      </div>
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
          Portal
        </p>
        <p
          className={
            "text-lg font-medium leading-tight " +
            (mode === "standalone" ? "text-green-400" : "text-zinc-400")
          }
        >
          {mode === "standalone" ? "Registered" : "Not registered"}
        </p>
      </div>
    </div>
  );
}
