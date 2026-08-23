import { describe, expect, it } from "vitest";
import { FOCUSABLE_SELECTOR, nextFocusableIndex } from "./focus-trap.js";

describe("focus trap helpers", () => {
  it("wraps forward and backward at the dialog edges", () => {
    expect(nextFocusableIndex(0, 3)).toBe(1);
    expect(nextFocusableIndex(2, 3)).toBe(0);
    expect(nextFocusableIndex(0, 3, true)).toBe(2);
    expect(nextFocusableIndex(2, 3, true)).toBe(1);
  });

  it("starts at the first or last element when focus is outside", () => {
    expect(nextFocusableIndex(-1, 3)).toBe(0);
    expect(nextFocusableIndex(-1, 3, true)).toBe(2);
  });

  it("returns a safe sentinel for an empty dialog", () => {
    expect(nextFocusableIndex(0, 0)).toBe(-1);
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
  });
});
