# Physical (attached) keyboard input on the kiosk

**Date:** 2026-06-29
**Status:** Approved, pending implementation plan

## Problem

Data entry on the touchscreen kiosk goes through `OnScreenKeyboard`. The edited
fields are not real `<input>` elements — they are buttons that display React
state, and the only way to change that state is tapping on-screen keys
(`onChange(value + ch)`). A USB/Bluetooth keyboard attached to the Pi does
nothing, because no focused text input receives native keystrokes.

We want an attached keyboard to work for the same fields: the add-reader step,
the wifi password, and the static-IP network fields.

## Goal

While a field is active on the kiosk, let a physical keyboard drive the same
value the on-screen keyboard edits — purely additive, no change to the touch
flow, no scheme/field selector changes.

## Decision (locked)

**Mirror approach.** The physical keyboard mirrors the on-screen keyboard: the
user still taps a field to make it active, then may type on either keyboard
interchangeably. We do NOT convert fields to focusable `<input>`s (that would be
a large refactor of all three screens and fights the kiosk touch flow).

## Design

All three surfaces (`StepReader`, `KioskInternet` wifi password, `KioskInternet`
static-IP fields) already render exactly one `OnScreenKeyboard` at a time, bound
to the active field's `value` / `onChange` / `onEnter` / `layout`. So physical
keyboard handling lives inside `OnScreenKeyboard` and every surface gets it at
once with no per-screen markup change.

### `usePhysicalKeyboard` hook (`portal/src/components/OnScreenKeyboard.tsx`)

A small hook called once from `OnScreenKeyboard`:

```ts
usePhysicalKeyboard({ value, onChange, onEnter, layout });
```

It attaches a `window` `keydown` listener on mount and removes it on unmount, so
it is always scoped to the active field. Since only one keyboard is mounted at a
time, there is no double-input.

Key handling:

| Physical key | Action |
|---|---|
| Printable single char (`e.key.length === 1`, no Ctrl/Meta/Alt) | `onChange(value + e.key)` |
| `Backspace` | `onChange(value.slice(0, -1))` |
| `Enter` | `onEnter?.()` |
| modifiers, function keys, arrows, `Tab`, etc. | ignored |

Details:

- **Shift/caps** are handled natively by the browser — `e.key` already carries
  the cased character. This is independent of the on-screen Shift/Sym toggles.
- **Layout filter:** in `numeric` mode only `0-9` and `.` are accepted (matches
  the numeric pad); `full` accepts the printable set.
- **`preventDefault()`** on handled keys so `Backspace` doesn't navigate back
  and `Enter` doesn't submit a stray form.
- **Guard:** if `e.target` is a real editable element (`input`, `textarea`,
  `[contenteditable]`), bail — none exist today, but this prevents
  double-handling if one is added later.
- The handler reads the latest `value`/`onChange`/`onEnter` via a ref so the
  listener doesn't need to be re-bound on every keystroke.

## Testing

New `portal` unit test for `usePhysicalKeyboard` (or `OnScreenKeyboard`),
dispatching synthetic `KeyboardEvent`s and asserting calls:

- printable char in `full` → `onChange(value + char)`.
- letter with Shift produces the cased char (browser sets `e.key`).
- `Backspace` → value minus last char.
- `Enter` → `onEnter` called once.
- `numeric` layout rejects a letter, accepts a digit and `.`.
- Ctrl/Meta-modified key is ignored.
- event whose target is an `<input>` is ignored.

## Scope

The three existing `OnScreenKeyboard` surfaces only. No other UI changes, no new
field selectors, no change to the on-screen keyboard's appearance or behavior.
