"use client";

import { useEffect, useState } from "react";
import {
  Banner,
  BannerBar,
  CollapsibleSection,
  Modal,
  SignalBars,
} from "@/components/settings/parts";

type Connection = {
  name: string;
  type: string;
  device: string;
  state: string;
  ip4?: string;
};

type WifiNetwork = {
  in_use: boolean;
  ssid: string;
  signal: number;
  security: string;
};

type Settings = {
  hostname: string;
  connections: Connection[];
  wan_ip?: string | null;
};

const NETWORK_REFRESH_MS = 10_000;
const WIFI_REFRESH_MS = 15_000;

const TYPE_LABEL: Record<string, string> = {
  "802-3-ethernet": "Ethernet",
  "802-11-wireless": "Wireless",
  loopback: "Loopback",
  bridge: "Bridge",
  bond: "Bond",
  vlan: "VLAN",
};

export default function NetworkSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [wifi, setWifi] = useState<WifiNetwork[]>([]);
  const [wifiLoading, setWifiLoading] = useState(false);
  const [connectModal, setConnectModal] = useState<{
    ssid: string;
    hidden: boolean;
  } | null>(null);
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [manualSsid, setManualSsid] = useState("");
  const [busy, setBusy] = useState<null | "wifi-connect" | "wifi-disconnect">(
    null
  );
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    refreshSettings();
    refreshWifi();
    const sid = setInterval(refreshSettings, NETWORK_REFRESH_MS);
    const wid = setInterval(refreshWifi, WIFI_REFRESH_MS);
    return () => {
      clearInterval(sid);
      clearInterval(wid);
    };
  }, []);

  async function refreshSettings() {
    try {
      const res = await fetch("/local/settings", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Settings;
      setSettings(data);
    } catch {
      /* keep last good data */
    }
  }

  async function refreshWifi() {
    setWifiLoading(true);
    try {
      const res = await fetch("/local/settings/wifi/networks", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { networks: WifiNetwork[] };
      setWifi(data.networks ?? []);
    } catch {
      /* keep last good data */
    } finally {
      setWifiLoading(false);
    }
  }

  function flash(kind: Banner["kind"], text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 7000);
  }

  async function doConnectWifi() {
    if (!connectModal) return;
    setBusy("wifi-connect");
    try {
      const res = await fetch("/local/settings/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: connectModal.ssid,
          password: pw,
          hidden: connectModal.hidden,
        }),
      });
      const body = await res.json().catch(() => null);
      setConnectModal(null);
      setPw("");
      setShowPw(false);
      if (res.ok) {
        flash("success", `Connected to ${body?.ssid ?? connectModal.ssid}.`);
        refreshSettings();
        refreshWifi();
      } else {
        flash("error", body?.detail ?? "Connection failed.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function doDisconnectWifi(ssid: string) {
    setBusy("wifi-disconnect");
    try {
      const res = await fetch("/local/settings/wifi/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        flash("success", `Disconnected from ${ssid}.`);
        refreshSettings();
        refreshWifi();
      } else {
        flash("error", body?.detail ?? "Disconnect failed.");
      }
    } finally {
      setBusy(null);
    }
  }

  function openConnectModal(ssid: string, hidden: boolean) {
    setConnectModal({ ssid, hidden });
    setPw("");
    setShowPw(false);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Network</h1>
        <p className="text-sm text-zinc-500">
          Wired and wireless connectivity. WAN address is auto-detected.
        </p>
      </header>

      {banner && <BannerBar banner={banner} />}

      {/* ---- Active connections (WAN first; loopback filtered) ---- */}
      <CollapsibleSection title="Active network connections">
        <div className="overflow-hidden rounded-md border border-zinc-100">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">State</th>
                <th className="px-3 py-2 text-left">IP address</th>
              </tr>
            </thead>
            <tbody>
              {settings && (
                <tr className="bg-zinc-50/60">
                  <td className="px-3 py-2 font-medium">
                    WAN
                    <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-blue-700">
                      Public
                    </span>
                  </td>
                  <td className="px-3 py-2 text-zinc-500">—</td>
                  <td className="px-3 py-2 text-zinc-500">
                    {settings.wan_ip ? "detected" : "unavailable"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                    {settings.wan_ip || "—"}
                  </td>
                </tr>
              )}
              {(settings?.connections ?? [])
                .filter((c) => c.type !== "loopback" && c.device !== "lo")
                .map((c) => (
                  <tr
                    key={`${c.name}-${c.device}`}
                    className="border-t border-zinc-100"
                  >
                    <td className="px-3 py-2 font-medium">{c.name}</td>
                    <td className="px-3 py-2 text-zinc-600">
                      {TYPE_LABEL[c.type] ?? c.type}
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{c.state}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                      {c.ip4 || "—"}
                    </td>
                  </tr>
                ))}
              {settings &&
                settings.connections.filter(
                  (c) => c.type !== "loopback" && c.device !== "lo"
                ).length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="border-t border-zinc-100 px-3 py-4 text-center text-xs text-zinc-400"
                    >
                      (no active wired/wireless connections)
                    </td>
                  </tr>
                )}
            </tbody>
          </table>
        </div>
      </CollapsibleSection>

      {/* ---- Wi-Fi ---- */}
      <CollapsibleSection
        title="Wi-Fi networks"
        rightSlot={
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              refreshWifi();
            }}
            disabled={wifiLoading}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-400"
          >
            {wifiLoading ? "Scanning…" : "Re-scan"}
          </button>
        }
      >
        <div className="overflow-hidden rounded-md border border-zinc-100">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 text-left">SSID</th>
                <th className="px-3 py-2 text-left">Signal</th>
                <th className="px-3 py-2 text-left">Security</th>
                <th className="px-3 py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {wifi.map((n) => (
                <tr key={n.ssid} className="border-t border-zinc-100">
                  <td className="px-3 py-2 font-medium">
                    {n.ssid}
                    {n.in_use && (
                      <span className="ml-2 rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-green-700">
                        Connected
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <SignalBars value={n.signal} />
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-600">
                    {n.security}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {n.in_use ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => doDisconnectWifi(n.ssid)}
                        className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:text-zinc-400"
                      >
                        {busy === "wifi-disconnect" ? "Working…" : "Disconnect"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => openConnectModal(n.ssid, false)}
                        className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-400"
                      >
                        Connect
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {wifi.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-4 text-center text-xs text-zinc-400"
                  >
                    {wifiLoading ? "Scanning…" : "(no networks detected)"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 rounded-md border border-zinc-100 bg-zinc-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Connect to hidden network
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              type="text"
              value={manualSsid}
              onChange={(e) => setManualSsid(e.target.value)}
              placeholder="SSID"
              className="min-w-[160px] flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
            />
            <button
              type="button"
              disabled={!manualSsid.trim() || busy !== null}
              onClick={() => openConnectModal(manualSsid.trim(), true)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-400"
            >
              Connect…
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {/* ---- Connect modal ---- */}
      {connectModal && (
        <Modal
          onCancel={() => {
            setConnectModal(null);
            setPw("");
            setShowPw(false);
          }}
        >
          <h3 className="text-lg font-semibold">
            Connect to {connectModal.ssid}
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            {connectModal.hidden
              ? "Hidden network"
              : "Enter the network password"}
          </p>
          <div className="mt-4">
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Password
            </label>
            <div className="mt-1 flex gap-2">
              <input
                type={showPw ? "text" : "password"}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="Leave blank for open networks"
                className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy === "wifi-connect"}
              onClick={() => {
                setConnectModal(null);
                setPw("");
                setShowPw(false);
              }}
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy === "wifi-connect"}
              onClick={doConnectWifi}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"
            >
              {busy === "wifi-connect" ? "Connecting…" : "Connect"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
