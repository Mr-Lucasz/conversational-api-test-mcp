import { describe, expect, it } from "vitest";
import { safeSliceString } from "../src/http/safeSlice.js";

describe("safeSliceString", () => {
  it("behaves like a normal slice when no surrogate pair is at the boundary", () => {
    expect(safeSliceString("hello world", 5)).toBe("hello");
  });

  it("does not split a surrogate pair (emoji) at the cut boundary", () => {
    const emoji = "\u{1F600}"; // 😀 — 2 UTF-16 code units
    const value = "abc" + emoji + "def"; // length 3 + 2 + 3 = 8
    const out = safeSliceString(value, 4); // would land right after the high surrogate
    expect(out).toBe("abc");
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("cutting exactly after a full surrogate pair keeps it intact", () => {
    const emoji = "\u{1F600}";
    const value = "ab" + emoji + "cd";
    expect(safeSliceString(value, 4)).toBe("ab" + emoji);
  });

  it("no-op when maxChars exceeds the string length", () => {
    expect(safeSliceString("short", 100)).toBe("short");
  });

  it("non-positive maxChars always truncates to empty, never returns the tail via negative-index slice", () => {
    expect(safeSliceString("hello world", 0)).toBe("");
    expect(safeSliceString("hello world", -5)).toBe("");
  });
});
