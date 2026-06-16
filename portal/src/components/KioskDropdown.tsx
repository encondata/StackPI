"use client";

import { useState } from "react";
import { ChevronDown, Check } from "lucide-react";

export type DropdownOption = {
  id: number;
  label: string;
  sublabel?: string;
  color?: string;
};

// Touch dropdown: a select-styled button that opens a slide-up overlay list.
// Anchors to the nearest positioned ancestor (the wizard <main> is relative).
export function KioskDropdown({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: number | null;
  options: DropdownOption[];
  placeholder?: string;
  onChange: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const sel = options.find((o) => o.id === value) ?? null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-14 w-full items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-left"
      >
        {sel?.color && (
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: sel.color }} />
        )}
        <span className={sel ? "text-zinc-100" : "text-zinc-500"}>
          {sel ? sel.label : placeholder ?? "Select…"}
        </span>
        {sel?.sublabel && <span className="text-xs text-zinc-500">{sel.sublabel}</span>}
        <ChevronDown className="ml-auto h-5 w-5 text-zinc-500" />
      </button>
      {open && (
        <div
          className="absolute inset-0 z-20 flex items-end bg-black/55"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[80%] w-full overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-950 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            {options.length === 0 && (
              <p className="p-4 text-sm text-zinc-500">No options available.</p>
            )}
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-zinc-900"
              >
                {o.color && (
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: o.color }} />
                )}
                <span className="text-zinc-100">{o.label}</span>
                {o.sublabel && <span className="text-xs text-zinc-500">{o.sublabel}</span>}
                {o.id === value && <Check className="ml-auto h-5 w-5 text-green-400" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
