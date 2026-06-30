"use client";

import { useEffect, useState } from "react";
import {
  Banner,
  BannerBar,
  CollapsibleSection,
  Modal,
} from "@/components/settings/parts";

type Settings = { hostname: string };

type TimeStatus = {
  timezone: string | null;
  local_time: string | null;
  utc_time: string | null;
  ntp_active: boolean;
  synchronized: boolean;
  current_server: string | null;
  ntp_servers_override: string[];
  timezone_auto: boolean;
};

const TIME_REFRESH_MS = 10_000;
const HOSTNAME_REFRESH_MS = 30_000;

const TIMEZONE_PRESETS = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "America/Honolulu",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Australia/Sydney",
];

export default function SystemSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [time, setTime] = useState<TimeStatus | null>(null);
  const [hostInput, setHostInput] = useState("");
  const [confirmHostname, setConfirmHostname] = useState(false);
  const [tzInput, setTzInput] = useState<string>("");
  const [tzCustom, setTzCustom] = useState<string>("");
  const [ntpInput, setNtpInput] = useState<string>("");
  const [statusInterval, setStatusInterval] = useState<string>("");
  const [statusMeta, setStatusMeta] = useState<{
    interval_seconds_default: number;
    interval_seconds_min: number;
    interval_seconds_max: number;
  } | null>(null);
  const [busy, setBusy] = useState<
    null | "hostname" | "timezone" | "ntp" | "device-status"
  >(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    refreshSettings();
    refreshTime();
    refreshDeviceStatus();
    const id = setInterval(refreshSettings, HOSTNAME_REFRESH_MS);
    const tid = setInterval(refreshTime, TIME_REFRESH_MS);
    return () => {
      clearInterval(id);
      clearInterval(tid);
    };
  }, []);

  async function refreshSettings() {
    try {
      const res = await fetch("/local/settings", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Settings;
      setSettings(data);
      setHostInput((prev) => (prev ? prev : data.hostname ?? ""));
    } catch {
      /* keep last good data */
    }
  }

  async function refreshTime() {
    try {
      const res = await fetch("/local/settings/time", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as TimeStatus;
      setTime(data);
      setTzInput((prev) => prev || data.timezone || "");
      setNtpInput((prev) =>
        prev || (data.ntp_servers_override || []).join(", ")
      );
    } catch {
      /* keep last good data */
    }
  }

  async function refreshDeviceStatus() {
    try {
      const res = await fetch("/local/settings/device-status", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        interval_seconds: number;
        interval_seconds_default: number;
        interval_seconds_min: number;
        interval_seconds_max: number;
      };
      setStatusInterval(String(data.interval_seconds));
      setStatusMeta({
        interval_seconds_default: data.interval_seconds_default,
        interval_seconds_min: data.interval_seconds_min,
        interval_seconds_max: data.interval_seconds_max,
      });
    } catch {
      /* keep last good data */
    }
  }

  function flash(kind: Banner["kind"], text: string) {
    setBanner({ kind, text });
    window.setTimeout(() => setBanner(null), 7000);
  }

  async function saveHostname() {
    if (!hostInput) return;
    setBusy("hostname");
    try {
      const res = await fetch("/local/settings/hostname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: hostInput.trim().toLowerCase() }),
      });
      const body = await res.json().catch(() => null);
      setConfirmHostname(false);
      if (res.ok) {
        window.location.replace("/rebooting");
        return;
      }
      flash("error", body?.detail ?? "Failed to save hostname.");
    } finally {
      setBusy(null);
    }
  }

  async function saveTimezone(zone: string) {
    setBusy("timezone");
    try {
      const res = await fetch("/local/settings/time/timezone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: zone }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        setTime(body as TimeStatus);
        flash("success", `Timezone set to ${zone}.`);
      } else {
        flash("error", body?.detail ?? "Failed to set timezone.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function saveNtpServers(rawList: string) {
    setBusy("ntp");
    try {
      const servers = rawList
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/local/settings/time/ntp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ servers }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        setTime(body as TimeStatus);
        flash(
          "success",
          servers.length === 0
            ? "Cleared NTP override; falling back to defaults."
            : `NTP servers set to ${servers.join(", ")}.`
        );
      } else {
        flash("error", body?.detail ?? "Failed to set NTP servers.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function saveTimezoneAuto(enabled: boolean) {
    setBusy("timezone");
    try {
      const res = await fetch("/local/settings/time/timezone-auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      if (res.ok) {
        flash("success", enabled ? "Automatic timezone enabled." : "Automatic timezone disabled.");
        await refreshTime();
      } else {
        flash("error", body?.detail ?? "Failed to update automatic timezone.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function saveDeviceStatus() {
    const min = statusMeta?.interval_seconds_min ?? 10;
    const max = statusMeta?.interval_seconds_max ?? 300;
    const parsed = parseInt(statusInterval, 10);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      flash("error", `Interval must be between ${min} and ${max} seconds.`);
      return;
    }
    setBusy("device-status");
    try {
      const res = await fetch("/local/settings/device-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval_seconds: parsed }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        if (typeof body.interval_seconds === "number") {
          setStatusInterval(String(body.interval_seconds));
        }
        setStatusMeta({
          interval_seconds_default: body.interval_seconds_default,
          interval_seconds_min: body.interval_seconds_min,
          interval_seconds_max: body.interval_seconds_max,
        });
        flash(
          "success",
          `Device status interval set to ${body.interval_seconds}s.`
        );
      } else {
        flash("error", body?.detail ?? "Failed to set device status interval.");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">System</h1>
        <p className="text-sm text-zinc-500">
          Identity and clock — hostname, timezone, and NTP servers.
        </p>
      </header>

      {banner && <BannerBar banner={banner} />}

      {/* ---- Hostname ---- */}
      <CollapsibleSection title="Hostname">
        <p className="text-xs text-zinc-500">
          A reboot is required to fully apply a new hostname. Saving schedules
          one 5 seconds out.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={hostInput}
            onChange={(e) => setHostInput(e.target.value)}
            placeholder="raspberrypi"
            className="w-64 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none"
          />
          <button
            type="button"
            disabled={
              busy !== null ||
              !hostInput.trim() ||
              hostInput.trim().toLowerCase() === settings?.hostname
            }
            onClick={() => setConfirmHostname(true)}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-zinc-300"
          >
            Save &amp; reboot
          </button>
          <span className="text-xs text-zinc-500">
            Current:{" "}
            <code className="font-mono">{settings?.hostname ?? "—"}</code>
          </span>
        </div>
      </CollapsibleSection>

      {/* ---- Time / NTP ---- */}
      <CollapsibleSection title="Time">
        <div className="space-y-4">
          {/* Current state */}
          <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span>
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Now:
                </span>{" "}
                <span className="font-mono">{time?.local_time ?? "—"}</span>
              </span>
              <span>
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Sync:
                </span>{" "}
                {time?.synchronized ? (
                  <span className="text-green-700">synchronized</span>
                ) : (
                  <span className="text-red-700">not synchronized</span>
                )}
              </span>
              {time?.current_server && (
                <span>
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Server:
                  </span>{" "}
                  <code className="font-mono text-xs">
                    {time.current_server}
                  </code>
                </span>
              )}
            </div>
          </div>

          {/* Timezone */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Timezone
            </p>
            <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={Boolean(time?.timezone_auto)}
                onChange={(e) => saveTimezoneAuto(e.target.checked)}
                disabled={busy !== null}
              />
              Set automatically from internet location
            </label>
            <p className="mt-1 text-xs text-zinc-500">
              Current:{" "}
              <code className="font-mono">{time?.timezone ?? "—"}</code>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={
                  TIMEZONE_PRESETS.includes(tzInput) ? tzInput : "__custom__"
                }
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setTzCustom(tzInput);
                  } else {
                    setTzInput(e.target.value);
                  }
                }}
                disabled={busy !== null}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
              >
                {TIMEZONE_PRESETS.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
                <option value="__custom__">Other…</option>
              </select>
              {!TIMEZONE_PRESETS.includes(tzInput) && (
                <input
                  type="text"
                  value={tzCustom}
                  onChange={(e) => {
                    setTzCustom(e.target.value);
                    setTzInput(e.target.value);
                  }}
                  placeholder="e.g. America/Indiana/Indianapolis"
                  className="w-72 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none"
                />
              )}
              <button
                type="button"
                disabled={
                  busy !== null ||
                  !tzInput.trim() ||
                  tzInput.trim() === time?.timezone
                }
                onClick={() => saveTimezone(tzInput.trim())}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-zinc-300"
              >
                {busy === "timezone" ? "Saving…" : "Save timezone"}
              </button>
            </div>
          </div>

          {/* NTP servers */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              NTP servers (override)
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Comma- or space-separated hostnames/IPs. Default:{" "}
              <code className="font-mono">pool.ntp.org</code>. Leave blank to use it.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={ntpInput}
                onChange={(e) => setNtpInput(e.target.value)}
                placeholder="pool.ntp.org, time.cloudflare.com"
                disabled={busy !== null}
                className="min-w-[280px] flex-1 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none"
              />
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => saveNtpServers(ntpInput)}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-zinc-300"
              >
                {busy === "ntp" ? "Saving…" : "Save NTP"}
              </button>
            </div>
            {time?.ntp_servers_override &&
            time.ntp_servers_override.length > 0 ? (
              <p className="mt-1 text-[11px] text-zinc-500">
                Active override:{" "}
                <code className="font-mono">
                  {time.ntp_servers_override.join(", ")}
                </code>
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-zinc-500">
                No override active — using system defaults.
              </p>
            )}
          </div>
        </div>
      </CollapsibleSection>

      {/* ---- Device Status ---- */}
      <CollapsibleSection title="Device Status">
        <p className="text-xs text-zinc-500">
          How often the device reports its status up to the portal.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="number"
            min={statusMeta?.interval_seconds_min ?? 10}
            max={statusMeta?.interval_seconds_max ?? 300}
            step={1}
            value={statusInterval}
            onChange={(e) => setStatusInterval(e.target.value)}
            disabled={busy !== null}
            className="w-32 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-blue-400 focus:outline-none"
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={saveDeviceStatus}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-zinc-300"
          >
            {busy === "device-status" ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          Allowed range: {statusMeta?.interval_seconds_min ?? 10}–
          {statusMeta?.interval_seconds_max ?? 300} seconds. Default:{" "}
          {statusMeta?.interval_seconds_default ?? "—"}s.
        </p>
      </CollapsibleSection>

      {/* ---- Modals ---- */}
      {confirmHostname && (
        <Modal onCancel={() => setConfirmHostname(false)}>
          <h3 className="text-lg font-semibold text-blue-700">
            Save hostname &amp; reboot?
          </h3>
          <p className="mt-3 text-sm text-zinc-700">
            The Pi's hostname will be changed to{" "}
            <code className="font-mono">{hostInput.trim().toLowerCase()}</code>{" "}
            and the device will reboot in 5 seconds.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy === "hostname"}
              onClick={() => setConfirmHostname(false)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy === "hostname"}
              onClick={saveHostname}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"
            >
              {busy === "hostname" ? "Saving…" : "Save & reboot"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
