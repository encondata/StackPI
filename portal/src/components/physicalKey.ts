// portal/src/components/physicalKey.ts
export type KeyLayout = "full" | "numeric";

export interface KeyResult {
  value: string;
  enter: boolean;
  handled: boolean;
}

const NUMERIC_RE = /^[0-9.]$/;

/**
 * Pure reducer for a physical key press against the value an OnScreenKeyboard
 * edits. `hasModifier` is true if Ctrl/Meta/Alt was held (such keys are
 * ignored). Shift is NOT a modifier here — the browser already folds it into a
 * cased single-character `key`.
 */
export function applyPhysicalKey(
  value: string,
  key: string,
  layout: KeyLayout,
  hasModifier: boolean,
): KeyResult {
  const unchanged = { value, enter: false, handled: false };
  if (hasModifier) return unchanged;
  if (key === "Enter") return { value, enter: true, handled: true };
  if (key === "Backspace") return { value: value.slice(0, -1), enter: false, handled: true };
  if (key.length !== 1) return unchanged; // named keys: arrows, Tab, F-keys, etc.
  if (layout === "numeric" && !NUMERIC_RE.test(key)) return unchanged;
  return { value: value + key, enter: false, handled: true };
}
