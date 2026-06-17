"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export type Banner = { kind: "success" | "error" | "info"; text: string };

export function CollapsibleSection({
  title,
  children,
  rightSlot,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className="flex cursor-pointer items-center justify-between gap-3 p-6 hover:bg-zinc-50/50"
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="flex items-center gap-3">
          {rightSlot && <div onClick={(e) => e.stopPropagation()}>{rightSlot}</div>}
          {open ? (
            <ChevronDown className="h-4 w-4 text-zinc-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-zinc-500" />
          )}
        </div>
      </div>
      {open && (
        <div className="border-t border-zinc-100 px-6 pb-6 pt-4">{children}</div>
      )}
    </section>
  );
}

export function Dropdown({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none disabled:bg-zinc-100 disabled:text-zinc-400"
      >
        {!value && (
          <option value="" disabled>
            (loading…)
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function BannerBar({ banner }: { banner: Banner }) {
  const cls =
    banner.kind === "success"
      ? "border-green-200 bg-green-50 text-green-800"
      : banner.kind === "error"
        ? "border-red-200 bg-red-50 text-red-800"
        : "border-blue-200 bg-blue-50 text-blue-800";
  return (
    <div role="status" className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
      {banner.text}
    </div>
  );
}

export function SignalBars({ value }: { value: number }) {
  const thresholds = [25, 50, 75, 90];
  return (
    <div className="inline-flex items-end gap-0.5">
      {thresholds.map((threshold, i) => (
        <span
          key={i}
          className={`inline-block w-1.5 rounded-sm ${
            value >= threshold ? "bg-zinc-700" : "bg-zinc-200"
          }`}
          style={{ height: `${(i + 1) * 4}px` }}
        />
      ))}
      <span className="ml-2 text-xs text-zinc-500">{value}%</span>
    </div>
  );
}

export function Modal({
  children,
  onCancel,
}: {
  children: React.ReactNode;
  onCancel: () => void;
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
        {children}
      </div>
    </div>
  );
}
