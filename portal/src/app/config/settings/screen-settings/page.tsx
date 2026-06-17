"use client";

import { useEffect, useState } from "react";
import {
  Banner,
  BannerBar,
  CollapsibleSection,
} from "@/components/settings/parts";

type ScreenChoice = "clock" | "status" | "trucks" | "cycle" | "off";
type SaverChoice = "30m" | "15m" | "5m" | "3m" | "1m" | "disabled";
type QRChoice = "enabled" | "disabled";

const SCREEN_OPTIONS = [
  { value: "clock", label: "Clock" },
  { value: "status", label: "Status" },
  { value: "trucks", label: "Trucks" },
  { value: "cycle", label: "Cycle" },
  { value: "off", label: "Off" },
];

const SAVER_OPTIONS = [
  { value: "30m", label: "30 min" },
  { value: "15m", label: "15 min" },
  { value: "5m", label: "5 min" },
  { value: "3m", label: "3 min" },
  { value: "1m", label: "1 min" },
  { value: "disabled", label: "Disabled" },
];

const QR_OPTIONS = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

type InfoScreenConfig = {
  default_screen: ScreenChoice;
  saver: SaverChoice;
  selector: ScreenChoice;
  show_qr: QRChoice;
};

type TouchScreenConfig = {
  show_qr: QRChoice;
};

const INITIAL_INFO: InfoScreenConfig = {
  default_screen: "clock",
  saver: "15m",
  selector: "clock",
  show_qr: "enabled",
};

const INITIAL_TOUCH: TouchScreenConfig = {
  show_qr: "enabled",
};

function configEqual(a: InfoScreenConfig, b: InfoScreenConfig): boolean {
  return (
    a.default_screen === b.default_screen &&
    a.saver === b.saver &&
    a.selector === b.selector &&
    a.show_qr === b.show_qr
  );
}

export default function ScreenSettingsPage() {
  // ── Info Screen 1 (wired to /local/screens/info1) ─────────────────────────
  const [info1, setInfo1] = useState<InfoScreenConfig>(INITIAL_INFO);
  const [info1Saved, setInfo1Saved] = useState<InfoScreenConfig>(INITIAL_INFO);
  const [info1Loaded, setInfo1Loaded] = useState(false);
  const [info1Busy, setInfo1Busy] = useState(false);
  const [info1Banner, setInfo1Banner] = useState<Banner | null>(null);

  // ── Info Screen 2 + Touch (still UI-only) ─────────────────────────────────
  const [info2, setInfo2] = useState<InfoScreenConfig>(INITIAL_INFO);
  const [touch, setTouch] = useState<TouchScreenConfig>(INITIAL_TOUCH);

  // Load Info Screen 1 from server on mount.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/local/screens/info1", { cache: "no-store" });
        if (!cancelled && r.ok) {
          const cfg = (await r.json()) as InfoScreenConfig;
          setInfo1(cfg);
          setInfo1Saved(cfg);
        }
      } finally {
        if (!cancelled) setInfo1Loaded(true);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function flashInfo1(kind: Banner["kind"], text: string) {
    setInfo1Banner({ kind, text });
    window.setTimeout(() => setInfo1Banner(null), 7000);
  }

  async function applyInfo1() {
    setInfo1Busy(true);
    try {
      const res = await fetch("/local/screens/info1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(info1),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        setInfo1Saved(body as InfoScreenConfig);
        setInfo1(body as InfoScreenConfig);
        flashInfo1("success", "Info Screen 1 updated.");
      } else {
        flashInfo1("error", body?.detail ?? "Failed to apply Info Screen 1.");
      }
    } finally {
      setInfo1Busy(false);
    }
  }

  const info1Dirty = info1Loaded && !configEqual(info1, info1Saved);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Screen Settings
        </h1>
        <p className="text-sm text-zinc-500">
          Configure display outputs and what each kiosk window shows.
        </p>
      </header>

      <CollapsibleSection title="Info Screen 1">
        {info1Banner && (
          <div className="mb-4">
            <BannerBar banner={info1Banner} />
          </div>
        )}
        <InfoScreenControls
          value={info1}
          onChange={setInfo1}
          disabled={info1Busy || !info1Loaded}
        />
        <div className="mt-4 flex items-center justify-end gap-3">
          {info1Dirty && (
            <span className="text-xs text-amber-600">unsaved changes</span>
          )}
          <button
            type="button"
            disabled={!info1Loaded || info1Busy || !info1Dirty}
            onClick={applyInfo1}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-zinc-300"
          >
            {info1Busy ? "Applying…" : "Apply"}
          </button>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Info Screen 2">
        <InfoScreenControls value={info2} onChange={setInfo2} />
      </CollapsibleSection>

      <CollapsibleSection title="Config TouchScreen">
        <SettingRow
          label="Show QR Registration"
          description="Display the pairing QR code while the device is unregistered."
        >
          <Select
            value={touch.show_qr}
            options={QR_OPTIONS}
            onChange={(v) => setTouch({ ...touch, show_qr: v as QRChoice })}
          />
        </SettingRow>
      </CollapsibleSection>
    </div>
  );
}

function InfoScreenControls({
  value,
  onChange,
  disabled = false,
}: {
  value: InfoScreenConfig;
  onChange: (v: InfoScreenConfig) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <SettingRow
        label="Default Screen"
        description="Initial view shown when the screen wakes."
      >
        <Select
          value={value.default_screen}
          options={SCREEN_OPTIONS}
          disabled={disabled}
          onChange={(v) =>
            onChange({ ...value, default_screen: v as ScreenChoice })
          }
        />
      </SettingRow>

      <SettingRow
        label="Screen Saver"
        description="Inactivity timeout before the screen blanks."
      >
        <Select
          value={value.saver}
          options={SAVER_OPTIONS}
          disabled={disabled}
          onChange={(v) => onChange({ ...value, saver: v as SaverChoice })}
        />
      </SettingRow>

      <SettingRow
        label="Screen Selector"
        description="Active view — overrides Default until changed."
      >
        <Select
          value={value.selector}
          options={SCREEN_OPTIONS}
          disabled={disabled}
          onChange={(v) => onChange({ ...value, selector: v as ScreenChoice })}
        />
      </SettingRow>

      <SettingRow
        label="Show QR Registration"
        description="Display the pairing QR code while the device is unregistered."
      >
        <Select
          value={value.show_qr}
          options={QR_OPTIONS}
          disabled={disabled}
          onChange={(v) => onChange({ ...value, show_qr: v as QRChoice })}
        />
      </SettingRow>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-zinc-100 py-3 last:border-0">
      <div className="min-w-[220px] flex-1">
        <p className="text-sm font-medium text-zinc-900">{label}</p>
        <p className="mt-0.5 text-xs text-zinc-500">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-48 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none disabled:bg-zinc-100 disabled:text-zinc-400"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
