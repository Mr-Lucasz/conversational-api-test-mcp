import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { textResult } from "../src/tools/toolResult.js";

describe("textResult", () => {
  it("encodes as TOON (not JSON) and round-trips back to the same data", () => {
    const data = { ok: true, files: ["a.yaml", "b.yaml"], truncated: false };
    const out = textResult(data);
    const text = out.content[0].text;

    expect(() => JSON.parse(text)).toThrow();
    expect(decode(text)).toEqual(data);
  });

  it("falls back to JSON instead of throwing when a lone surrogate reaches encode() directly", () => {
    // Simula um caso não coberto pelo truncamento conhecido (safeSlice.ts) — a
    // rede de segurança do textResult deve absorver isso, nunca derrubar a chamada.
    const loneSurrogate = "abc\uD83D"; // high surrogate sem par
    const out = textResult({ ok: true, message: loneSurrogate });
    const text = out.content[0].text;
    expect(() => JSON.parse(text)).not.toThrow();
    expect((JSON.parse(text) as { message: string }).message).toBe(loneSurrogate);
  });

  it("sets isError when requested", () => {
    const out = textResult({ error: "boom" }, true);
    expect(out.isError).toBe(true);
  });
});
