"use client";

import { useEffect, useRef, useState } from "react";
import { applyPhysicalKey } from "./physicalKey";
import { Delete, ArrowBigUp, CornerDownLeft } from "lucide-react";

type Layout = "full" | "numeric";

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
}

/**
 * While mounted, lets a physically-attached keyboard drive the same value the
 * on-screen keyboard edits. Scoped to whichever field is active because only
 * one OnScreenKeyboard is mounted at a time. Latest props are read through a
 * ref so the window listener is bound once.
 */
function usePhysicalKeyboard({
  value,
  onChange,
  onEnter,
  layout,
}: {
  value: string;
  onChange: (next: string) => void;
  onEnter?: () => void;
  layout: Layout;
}) {
  const ref = useRef({ value, onChange, onEnter, layout });
  ref.current = { value, onChange, onEnter, layout };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      const { value: v, onChange: oc, onEnter: oe, layout: lay } = ref.current;
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      const res = applyPhysicalKey(v, e.key, lay, hasModifier);
      if (!res.handled) return;
      e.preventDefault();
      if (res.enter) {
        oe?.();
      } else if (res.value !== v) {
        oc(res.value);
      } else if (e.key === "Backspace") {
        oc(res.value); // keep state consistent on empty-backspace
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

// On-screen keyboard for the touchscreen kiosk. `full` = alphanumeric+symbols
// (WiFi passwords); `numeric` = digits + "." (IP entry). Stateless w.r.t. the
// edited value — the parent owns it; we emit change/enter.
export function OnScreenKeyboard({
  value,
  onChange,
  onEnter,
  layout = "full",
}: {
  value: string;
  onChange: (next: string) => void;
  onEnter?: () => void;
  layout?: Layout;
}) {
  const [shift, setShift] = useState(false);
  const [sym, setSym] = useState(false);

  usePhysicalKeyboard({ value, onChange, onEnter, layout });

  const press = (ch: string) => onChange(value + ch);
  const backspace = () => onChange(value.slice(0, -1));

  if (layout === "numeric") {
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"];
    return (
      <div className="grid grid-cols-3 gap-2">
        {keys.map((k) => (
          <Key key={k} onClick={() => press(k)}>
            {k}
          </Key>
        ))}
        <Key onClick={backspace} aria-label="Backspace">
          <Delete className="h-6 w-6" />
        </Key>
      </div>
    );
  }

  const letters = shift
    ? [
        ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
        ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
        ["Z", "X", "C", "V", "B", "N", "M"],
      ]
    : [
        ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
        ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
        ["z", "x", "c", "v", "b", "n", "m"],
      ];
  const symbols = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["@", "#", "$", "_", "&", "-", "+", "(", ")"],
    ["*", '"', "'", ":", ";", "!", "?", "/", "."],
  ];
  const rows = sym ? symbols : letters;

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex justify-center gap-1.5">
          {i === 2 && !sym && (
            <Key wide onClick={() => setShift((s) => !s)} active={shift} aria-label="Shift">
              <ArrowBigUp className="h-5 w-5" />
            </Key>
          )}
          {row.map((k) => (
            <Key key={k} onClick={() => press(k)}>
              {k}
            </Key>
          ))}
          {i === 2 && (
            <Key wide onClick={backspace} aria-label="Backspace">
              <Delete className="h-5 w-5" />
            </Key>
          )}
        </div>
      ))}
      <div className="flex justify-center gap-1.5">
        <Key wide onClick={() => setSym((s) => !s)}>
          {sym ? "abc" : "?123"}
        </Key>
        <Key onClick={() => press(" ")} className="flex-[6]">
          space
        </Key>
        {onEnter && (
          <Key wide onClick={onEnter} aria-label="Enter">
            <CornerDownLeft className="h-5 w-5" />
          </Key>
        )}
      </div>
    </div>
  );
}

function Key({
  children,
  onClick,
  wide = false,
  active = false,
  className = "",
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  wide?: boolean;
  active?: boolean;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex h-10 min-w-[2rem] flex-1 items-center justify-center rounded-md border text-base " +
        (active
          ? "border-blue-500 bg-blue-600 text-white "
          : "border-zinc-700 bg-zinc-800 text-zinc-100 ") +
        (wide ? "max-w-[5rem] " : "max-w-[3.25rem] ") +
        className
      }
      {...rest}
    >
      {children}
    </button>
  );
}
