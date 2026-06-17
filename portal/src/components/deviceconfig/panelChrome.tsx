"use client";

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

// Shared touch-friendly building blocks for the /device-config panels. Sized
// for the 800×480 kiosk touchscreen: large hit targets, dark theme matching
// the home screen.

export function PanelShell({
  title,
  onBack,
  children,
  footer,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 flex-none items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-10 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 text-sm font-medium text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="text-xl font-semibold text-zinc-100">{title}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-auto py-2">{children}</div>
      {footer && (
        <footer className="flex h-[52px] flex-none items-center justify-end gap-3 border-t border-zinc-800 pt-3">
          {footer}
        </footer>
      )}
    </div>
  );
}

export function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-12 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-base text-zinc-100 disabled:opacity-50"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Stepper({
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - step))}
        className="h-12 w-12 rounded-lg border border-zinc-700 bg-zinc-800 text-2xl font-bold text-zinc-100 disabled:opacity-40"
        aria-label="decrease"
      >
        −
      </button>
      <div className="min-w-[8rem] text-center font-mono text-2xl tabular-nums text-zinc-100">
        {value}
        {unit ? <span className="ml-1 text-base text-zinc-400">{unit}</span> : null}
      </div>
      <button
        type="button"
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + step))}
        className="h-12 w-12 rounded-lg border border-zinc-700 bg-zinc-800 text-2xl font-bold text-zinc-100 disabled:opacity-40"
        aria-label="increase"
      >
        +
      </button>
    </div>
  );
}

export function Banner({ kind, text }: { kind: "success" | "error"; text: string }) {
  return (
    <div
      role="status"
      className={
        "rounded-md border px-3 py-2 text-sm " +
        (kind === "success"
          ? "border-green-700 bg-green-900/30 text-green-300"
          : "border-red-700 bg-red-900/30 text-red-300")
      }
    >
      {text}
    </div>
  );
}
