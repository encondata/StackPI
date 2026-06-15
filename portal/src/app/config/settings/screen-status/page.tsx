"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChangeBorder,
  changeBorderDurationMs,
  toChangeBorderStyle,
  type ChangeBorderStyle,
} from "@/components/ChangeBorder";

type ScreenStatusSettings = {
  auto_clear_minutes: number;
  auto_clear_minutes_default: number;
  auto_clear_minutes_min: number;
  auto_clear_minutes_max: number;

  change_border_width_px: number;
  change_border_width_px_default: number;
  change_border_width_px_min: number;
  change_border_width_px_max: number;

  change_border_color: string;
  change_border_color_default: string;

  change_border_cycle_count: number;
  change_border_cycle_count_default: number;
  change_border_cycle_count_min: number;
  change_border_cycle_count_max: number;

  change_border_style: string;
  change_border_style_default: string;
  change_border_style_options: string[];
};

// Preview mirrors the 8 metric cards on /status. 4-wide grid (2 rows)
// keeps each preview box large enough that the configured border width
// reads at roughly the same visual weight it'll have on /status. Stagger
// picks the pace — 600ms feels distinctly sequential without dragging.
const PREVIEW_BOX_COUNT = 8;
const PREVIEW_STAGGER_MS = 600;

// --- Color conversion helpers (hex / rgb / hsl) --------------------------

type RGB = { r: number; g: number; b: number };
type HSL = { h: number; s: number; l: number };

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function parseColor(input: string): RGB {
  const s = (input || "").trim();
  const fallback: RGB = { r: 34, g: 197, b: 94 };
  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length >= 6) {
      const n = parseInt(hex.slice(0, 6), 16);
      if (Number.isFinite(n)) {
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
      }
    }
    return fallback;
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    return {
      r: clamp(+rgb[1], 0, 255),
      g: clamp(+rgb[2], 0, 255),
      b: clamp(+rgb[3], 0, 255),
    };
  }
  const hsl = s.match(/^hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/i);
  if (hsl) {
    return hslToRgb({
      h: clamp(+hsl[1], 0, 360),
      s: clamp(+hsl[2], 0, 100),
      l: clamp(+hsl[3], 0, 100),
    });
  }
  return fallback;
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rr:
        h = (gg - bb) / d + (gg < bb ? 6 : 0);
        break;
      case gg:
        h = (bb - rr) / d + 2;
        break;
      case bb:
        h = (rr - gg) / d + 4;
        break;
    }
    h *= 60;
  }
  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  const ss = s / 100;
  const ll = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = ss * Math.min(ll, 1 - ll);
  const f = (n: number) =>
    ll - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return {
    r: Math.round(255 * f(0)),
    g: Math.round(255 * f(8)),
    b: Math.round(255 * f(4)),
  };
}

function rgbCss({ r, g, b }: RGB): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function hslCss({ h, s, l }: HSL): string {
  return `hsl(${h}, ${s}%, ${l}%)`;
}

// -------------------------------------------------------------------------

export default function ScreenStatusSettingsPage() {
  const [data, setData] = useState<ScreenStatusSettings | null>(null);
  const [autoClearInput, setAutoClearInput] = useState<string>("");
  const [borderWidthInput, setBorderWidthInput] = useState<string>("");
  const [borderColor, setBorderColor] = useState<string>("");
  const [cycleCountInput, setCycleCountInput] = useState<string>("");
  const [borderStyleInput, setBorderStyleInput] =
    useState<ChangeBorderStyle>("comet");
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  // Preview test: cycles a chase fire through preview boxes 0..N-1. -1
  // means idle. Increment-per-box trigger ids ensure CSS animation
  // restarts cleanly each fire.
  const [previewIndex, setPreviewIndex] = useState<number>(-1);
  const [previewBumps, setPreviewBumps] = useState<number[]>(() =>
    Array(PREVIEW_BOX_COUNT).fill(0),
  );
  const previewTimers = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/local/settings/screen-status", {
          cache: "no-store",
        });
        if (!cancelled && res.ok) {
          const body = (await res.json()) as ScreenStatusSettings;
          setData(body);
          setAutoClearInput(String(body.auto_clear_minutes));
          setBorderWidthInput(String(body.change_border_width_px));
          setBorderColor(body.change_border_color);
          setCycleCountInput(String(body.change_border_cycle_count));
          setBorderStyleInput(toChangeBorderStyle(body.change_border_style));
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
    const auto = Number.parseInt(autoClearInput, 10);
    const width = Number.parseInt(borderWidthInput, 10);
    const cycles = Number.parseInt(cycleCountInput, 10);
    if (
      !Number.isFinite(auto) ||
      auto < data.auto_clear_minutes_min ||
      auto > data.auto_clear_minutes_max
    ) {
      flash(
        "error",
        `Auto-clear must be between ${data.auto_clear_minutes_min} and ${data.auto_clear_minutes_max} minutes.`,
      );
      return;
    }
    if (
      !Number.isFinite(width) ||
      width < data.change_border_width_px_min ||
      width > data.change_border_width_px_max
    ) {
      flash(
        "error",
        `Border width must be between ${data.change_border_width_px_min} and ${data.change_border_width_px_max} px.`,
      );
      return;
    }
    if (
      !Number.isFinite(cycles) ||
      cycles < data.change_border_cycle_count_min ||
      cycles > data.change_border_cycle_count_max
    ) {
      flash(
        "error",
        `Cycle count must be between ${data.change_border_cycle_count_min} and ${data.change_border_cycle_count_max}.`,
      );
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/local/settings/screen-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auto_clear_minutes: auto,
          change_border_width_px: width,
          change_border_color: borderColor,
          change_border_cycle_count: cycles,
          change_border_style: borderStyleInput,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        const updated = body as ScreenStatusSettings;
        setData(updated);
        setAutoClearInput(String(updated.auto_clear_minutes));
        setBorderWidthInput(String(updated.change_border_width_px));
        setBorderColor(updated.change_border_color);
        setCycleCountInput(String(updated.change_border_cycle_count));
        setBorderStyleInput(toChangeBorderStyle(updated.change_border_style));
        flash("success", "Settings saved.");
      } else {
        const detail = (body as { detail?: string } | null)?.detail;
        flash("error", detail ?? "Failed to save settings.");
      }
    } finally {
      setBusy(false);
    }
  }

  // Clear any pending preview timers if the page unmounts mid-sequence.
  useEffect(() => {
    return () => {
      for (const id of previewTimers.current) window.clearTimeout(id);
      previewTimers.current = [];
    };
  }, []);

  function runPreviewTest() {
    // Cancel any in-flight sequence before starting a new one.
    for (const id of previewTimers.current) window.clearTimeout(id);
    previewTimers.current = [];
    setPreviewIndex(0);
    setPreviewBumps((prev) => {
      const next = [...prev];
      next[0] = next[0] + 1;
      return next;
    });
    for (let i = 1; i < PREVIEW_BOX_COUNT; i++) {
      const id = window.setTimeout(() => {
        setPreviewIndex(i);
        setPreviewBumps((prev) => {
          const next = [...prev];
          next[i] = next[i] + 1;
          return next;
        });
      }, i * PREVIEW_STAGGER_MS);
      previewTimers.current.push(id);
    }
    // After the last box finishes its animation, reset the index so the
    // panel doesn't visually indicate any box as "current" forever.
    const endId = window.setTimeout(
      () => setPreviewIndex(-1),
      PREVIEW_BOX_COUNT * PREVIEW_STAGGER_MS + 1400,
    );
    previewTimers.current.push(endId);

    // Fire the test on the live /status page too. The kiosk polls
    // /local/settings/screen-status and runs the chase sequence on every
    // change to chase_test_triggered_at. Fire-and-forget — local preview
    // already gives the operator instant visual feedback either way.
    void fetch("/local/settings/screen-status/test", { method: "POST" }).catch(
      () => undefined,
    );
  }

  const previewWidth = Number.parseInt(borderWidthInput, 10);
  const previewWidthSafe = Number.isFinite(previewWidth)
    ? Math.max(1, Math.min(50, previewWidth))
    : data?.change_border_width_px ?? 10;
  const previewCycleParsed = Number.parseInt(cycleCountInput, 10);
  const previewCycleCount = Number.isFinite(previewCycleParsed)
    ? Math.max(1, Math.min(10, previewCycleParsed))
    : data?.change_border_cycle_count ?? 2;
  const testRunning = previewIndex >= 0;

  const dirty =
    data != null &&
    (String(data.auto_clear_minutes) !== autoClearInput.trim() ||
      String(data.change_border_width_px) !== borderWidthInput.trim() ||
      data.change_border_color !== borderColor ||
      data.change_border_style !== borderStyleInput ||
      String(data.change_border_cycle_count) !== cycleCountInput.trim());

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Status Screen</h1>
        <p className="text-sm text-zinc-500">
          Settings that control the behavior of the{" "}
          <code className="font-mono">/status</code> kiosk page. Changes
          take effect within ~30 seconds without reloading the kiosk.
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
        <h2 className="text-base font-semibold">RFID Activity Auto-Clear</h2>
        <p className="mt-1 text-sm text-zinc-500">
          How often the RFID Activity panel is cleared. On each clear, an
          entry is appended to System Events on the same page.
        </p>
        <div className="mt-5 flex items-end gap-3">
          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Auto-clear interval
            </span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={data?.auto_clear_minutes_min ?? 1}
                max={data?.auto_clear_minutes_max ?? 1440}
                step={1}
                value={autoClearInput}
                disabled={busy || !data}
                onChange={(e) => setAutoClearInput(e.target.value)}
                className="w-28 rounded-md border border-zinc-300 px-3 py-1.5 text-right font-mono text-sm tabular-nums disabled:opacity-60"
              />
              <span className="text-sm text-zinc-600">minutes</span>
            </div>
          </label>
        </div>
        {data && (
          <p className="mt-3 text-xs text-zinc-500">
            Allowed range:{" "}
            <span className="font-mono">{data.auto_clear_minutes_min}</span>
            –
            <span className="font-mono">{data.auto_clear_minutes_max}</span>{" "}
            minutes. Default:{" "}
            <span className="font-mono">{data.auto_clear_minutes_default}</span>
            .
          </p>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Change Animation</h2>
        <p className="mt-1 text-sm text-zinc-500">
          When a value inside a card changes, a colored border chases
          clockwise around the card. These settings control its appearance.
        </p>

        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Style
            </span>
            <div className="mt-1">
              <select
                value={borderStyleInput}
                disabled={busy || !data}
                onChange={(e) =>
                  setBorderStyleInput(toChangeBorderStyle(e.target.value))
                }
                className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm capitalize disabled:opacity-60"
              >
                {(data?.change_border_style_options ?? ["comet", "pulse", "dual"]).map(
                  (opt) => (
                    <option key={opt} value={opt} className="capitalize">
                      {opt}
                    </option>
                  ),
                )}
              </select>
            </div>
            {data && (
              <p className="mt-2 text-xs text-zinc-500">
                Default:{" "}
                <span className="font-mono capitalize">
                  {data.change_border_style_default}
                </span>
                .
              </p>
            )}
          </label>

          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Border width
            </span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={data?.change_border_width_px_min ?? 1}
                max={data?.change_border_width_px_max ?? 50}
                step={1}
                value={borderWidthInput}
                disabled={busy || !data}
                onChange={(e) => setBorderWidthInput(e.target.value)}
                className="w-28 rounded-md border border-zinc-300 px-3 py-1.5 text-right font-mono text-sm tabular-nums disabled:opacity-60"
              />
              <span className="text-sm text-zinc-600">px</span>
            </div>
            {data && (
              <p className="mt-2 text-xs text-zinc-500">
                Allowed:{" "}
                <span className="font-mono">
                  {data.change_border_width_px_min}
                </span>
                –
                <span className="font-mono">
                  {data.change_border_width_px_max}
                </span>
                . Default:{" "}
                <span className="font-mono">
                  {data.change_border_width_px_default}
                </span>
                .
              </p>
            )}
          </label>

          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Cycle count
            </span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={data?.change_border_cycle_count_min ?? 1}
                max={data?.change_border_cycle_count_max ?? 10}
                step={1}
                value={cycleCountInput}
                disabled={busy || !data}
                onChange={(e) => setCycleCountInput(e.target.value)}
                className="w-28 rounded-md border border-zinc-300 px-3 py-1.5 text-right font-mono text-sm tabular-nums disabled:opacity-60"
              />
              <span className="text-sm text-zinc-600">
                {borderStyleInput === "pulse" ? "pulses" : "revolutions"}
              </span>
            </div>
            {data && (
              <p className="mt-2 text-xs text-zinc-500">
                Allowed:{" "}
                <span className="font-mono">
                  {data.change_border_cycle_count_min}
                </span>
                –
                <span className="font-mono">
                  {data.change_border_cycle_count_max}
                </span>
                . Default:{" "}
                <span className="font-mono">
                  {data.change_border_cycle_count_default}
                </span>
                .
              </p>
            )}
          </label>

          <div>
            <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Border color
            </span>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setColorPickerOpen(true)}
                disabled={busy || !data}
                className="flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm hover:bg-zinc-50 disabled:opacity-60"
              >
                <span
                  className="inline-block h-5 w-5 rounded border border-zinc-200"
                  style={{ backgroundColor: borderColor || "transparent" }}
                  aria-hidden
                />
                <span className="font-mono text-xs tabular-nums">
                  {borderColor || "—"}
                </span>
              </button>
            </div>
            {data && (
              <p className="mt-2 text-xs text-zinc-500">
                Accepted formats: hex (#RRGGBB), rgb(…), or hsl(…). Default:{" "}
                <span className="font-mono">
                  {data.change_border_color_default}
                </span>
                .
              </p>
            )}
          </div>
        </div>

        {/* Preview row + Test button. Uses the CURRENT form values, not
            the persisted ones, so you can dial in the look first. */}
        <div className="mt-6 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Preview
            </p>
            <p className="text-xs text-zinc-500">
              Click Test to fire the chase sequentially across the eight
              cards mirroring the /status layout.
            </p>
          </div>
          <button
            type="button"
            onClick={runPreviewTest}
            disabled={!borderColor || testRunning}
            className="rounded-md border border-blue-200 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60"
          >
            {testRunning ? "Running…" : "Test"}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-3">
          {Array.from({ length: PREVIEW_BOX_COUNT }).map((_, i) => (
            <PreviewBox
              key={i}
              index={i}
              bump={previewBumps[i] ?? 0}
              chaseColor={borderColor || "#22c55e"}
              chaseWidthPx={previewWidthSafe}
              chaseCycleCount={previewCycleCount}
              chaseStyle={borderStyleInput}
            />
          ))}
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty || !data}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Apply"}
        </button>
      </div>

      {colorPickerOpen && (
        <ColorPickerPopup
          initialValue={borderColor}
          onCancel={() => setColorPickerOpen(false)}
          onConfirm={(v) => {
            setBorderColor(v);
            setColorPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

// -- Color picker popup ---------------------------------------------------

function ColorPickerPopup({
  initialValue,
  onConfirm,
  onCancel,
}: {
  initialValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"rgb" | "hsl">("rgb");
  const [rgb, setRgb] = useState<RGB>(() => parseColor(initialValue));
  const hsl = useMemo(() => rgbToHsl(rgb), [rgb]);
  const cssPreview = rgbCss(rgb);

  function patchRgb(p: Partial<RGB>) {
    setRgb({ ...rgb, ...p });
  }
  function patchHsl(p: Partial<HSL>) {
    setRgb(hslToRgb({ ...hsl, ...p }));
  }

  function submit() {
    onConfirm(mode === "rgb" ? rgbCss(rgb) : hslCss(hsl));
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
        <h3 className="text-lg font-semibold text-zinc-900">Pick a color</h3>

        <div className="mt-4 flex items-center gap-3">
          <div
            className="h-16 w-16 shrink-0 rounded-md border border-zinc-200"
            style={{ backgroundColor: cssPreview }}
            aria-label="Color preview"
          />
          <div className="min-w-0 flex-1 font-mono text-xs text-zinc-600">
            <p className="truncate">
              <span className="text-zinc-400">RGB:&nbsp;</span>
              {rgbCss(rgb)}
            </p>
            <p className="truncate">
              <span className="text-zinc-400">HSL:&nbsp;</span>
              {hslCss(hsl)}
            </p>
          </div>
        </div>

        <div className="mt-4 inline-flex rounded-md border border-zinc-200 p-0.5">
          {(["rgb", "hsl"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 text-xs font-medium uppercase tracking-wide ${
                mode === m
                  ? "bg-blue-600 text-white"
                  : "text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === "rgb" ? (
          <div className="mt-4 space-y-3">
            <ChannelInput
              label="R"
              max={255}
              value={rgb.r}
              onChange={(v) => patchRgb({ r: v })}
            />
            <ChannelInput
              label="G"
              max={255}
              value={rgb.g}
              onChange={(v) => patchRgb({ g: v })}
            />
            <ChannelInput
              label="B"
              max={255}
              value={rgb.b}
              onChange={(v) => patchRgb({ b: v })}
            />
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <ChannelInput
              label="H"
              max={360}
              value={hsl.h}
              onChange={(v) => patchHsl({ h: v })}
            />
            <ChannelInput
              label="S"
              max={100}
              suffix="%"
              value={hsl.s}
              onChange={(v) => patchHsl({ s: v })}
            />
            <ChannelInput
              label="L"
              max={100}
              suffix="%"
              value={hsl.l}
              onChange={(v) => patchHsl({ l: v })}
            />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewBox({
  index,
  bump,
  chaseColor,
  chaseWidthPx,
  chaseCycleCount,
  chaseStyle,
}: {
  index: number;
  bump: number;
  chaseColor: string;
  chaseWidthPx: number;
  chaseCycleCount: number;
  chaseStyle: ChangeBorderStyle;
}) {
  // Mirror MetricCard's auto-hide behavior so the preview matches what
  // happens on /status: chase appears for the configured number of
  // revolutions, then the box returns to its plain state.
  const [visibleBump, setVisibleBump] = useState<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const prevBumpRef = useRef<number>(bump);
  const cyclesRef = useRef<number>(chaseCycleCount);
  useEffect(() => {
    cyclesRef.current = chaseCycleCount;
  }, [chaseCycleCount]);

  useEffect(() => {
    if (bump !== prevBumpRef.current && bump > 0) {
      prevBumpRef.current = bump;
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
      setVisibleBump(bump);
      const cycles = Math.max(1, cyclesRef.current);
      hideTimerRef.current = window.setTimeout(() => {
        setVisibleBump(null);
        hideTimerRef.current = null;
      }, changeBorderDurationMs(chaseStyle, cycles) + 250);
    }
  }, [bump]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="relative flex aspect-square flex-col items-center justify-center overflow-visible rounded-xl border border-zinc-800 bg-zinc-900 px-1">
      {visibleBump !== null && (
        <ChangeBorder
          key={visibleBump}
          style={chaseStyle}
          color={chaseColor}
          widthPx={chaseWidthPx}
          cornerRadiusPx={12}
          cycleCount={Math.max(1, chaseCycleCount)}
        />
      )}
      <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
        Card
      </p>
      <p className="font-mono text-xl leading-none tabular-nums text-zinc-100">
        {index + 1}
      </p>
    </div>
  );
}


function ChannelInput({
  label,
  max,
  value,
  suffix,
  onChange,
}: {
  label: string;
  max: number;
  value: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-[2rem_1fr_5rem] items-center gap-2">
      <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </label>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value), 0, max))}
        className="w-full"
      />
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(clamp(Number(e.target.value), 0, max))}
          className="w-16 rounded-md border border-zinc-300 px-2 py-1 text-right font-mono text-xs tabular-nums"
        />
        {suffix && <span className="text-xs text-zinc-500">{suffix}</span>}
      </div>
    </div>
  );
}
