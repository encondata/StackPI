// portal/src/components/physicalKey.test.ts
import { describe, it, expect } from "vitest";
import { applyPhysicalKey } from "./physicalKey";

describe("applyPhysicalKey", () => {
  it("appends a printable char in full layout", () => {
    expect(applyPhysicalKey("ab", "c", "full", false)).toEqual({ value: "abc", enter: false, handled: true });
  });

  it("appends the cased char the browser provides (Shift handled natively)", () => {
    expect(applyPhysicalKey("a", "B", "full", false)).toEqual({ value: "aB", enter: false, handled: true });
  });

  it("backspace removes the last char", () => {
    expect(applyPhysicalKey("abc", "Backspace", "full", false)).toEqual({ value: "ab", enter: false, handled: true });
  });

  it("backspace on empty stays empty", () => {
    expect(applyPhysicalKey("", "Backspace", "full", false)).toEqual({ value: "", enter: false, handled: true });
  });

  it("enter signals submit without changing value", () => {
    expect(applyPhysicalKey("abc", "Enter", "full", false)).toEqual({ value: "abc", enter: true, handled: true });
  });

  it("numeric layout accepts digits and dot", () => {
    expect(applyPhysicalKey("10", ".", "numeric", false)).toEqual({ value: "10.", enter: false, handled: true });
    expect(applyPhysicalKey("1", "9", "numeric", false)).toEqual({ value: "19", enter: false, handled: true });
  });

  it("numeric layout rejects letters", () => {
    expect(applyPhysicalKey("10", "a", "numeric", false)).toEqual({ value: "10", enter: false, handled: false });
  });

  it("ignores keys pressed with a modifier", () => {
    expect(applyPhysicalKey("ab", "c", "full", true)).toEqual({ value: "ab", enter: false, handled: false });
  });

  it("ignores non-printable named keys", () => {
    expect(applyPhysicalKey("ab", "ArrowLeft", "full", false)).toEqual({ value: "ab", enter: false, handled: false });
  });
});
