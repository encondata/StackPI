"use client";

import { useState } from "react";
import { Delete, ArrowBigUp, CornerDownLeft } from "lucide-react";

type Layout = "full" | "numeric";

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
