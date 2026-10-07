import { describe, expect, it } from "vitest";
import {
  buildBodyPresentation,
  MAX_BODY_OUT,
} from "../src/http/bodyPresentation.js";

describe("buildBodyPresentation", () => {
  it("parses full JSON before any truncation — small payload returns bodyJson object", () => {
    const raw = JSON.stringify({ a: 1, b: "two" });
    const p = buildBodyPresentation(raw);
    expect(p.bodyJson).toEqual({ a: 1, b: "two" });
    expect(p.bodyPreview).toBe(raw);
    expect(p.bodyPreviewTruncated).toBe(false);
  });

  it("never truncates string before parse — large valid JSON still parses", () => {
    const huge = `{"wrap":"${"z".repeat(MAX_BODY_OUT)}"}`;
    expect(huge.length).toBeGreaterThan(MAX_BODY_OUT);
    const p = buildBodyPresentation(huge);
    expect(p.bodyPreviewTruncated).toBe(true);
    expect(p.bodyJson).toMatchObject({
      _note: expect.any(String),
      _payloadCharCount: huge.length,
      topLevelKeys: ["wrap"],
    });
  });

  it("non-JSON body has no bodyJson", () => {
    const p = buildBodyPresentation("<html></html>");
    expect(p.bodyJson).toBeUndefined();
    expect(p.bodyPreview).toContain("<html>");
  });

  it("empty string fails parse and has no bodyJson", () => {
    const p = buildBodyPresentation("");
    expect(p.bodyJson).toBeUndefined();
  });

  it("aplica jsonPathSelect e retorna projeção em bodyJson", () => {
    const raw = JSON.stringify({ a: { b: 2 }, c: 3 });
    const p = buildBodyPresentation(raw, { jsonPathSelect: "$.a" });
    expect(p.bodyJson).toEqual({ b: 2 });
    expect(p.bodyPreview).toContain('"b"');
    expect(p.bodyPreviewTruncated).toBe(false);
  });

  it("maxBodyChars trunca preview da projeção", () => {
    const raw = JSON.stringify({ a: { b: 2, long: "x".repeat(200) } });
    const p = buildBodyPresentation(raw, {
      jsonPathSelect: "$.a.long",
      maxBodyChars: 20,
    });
    expect(p.bodyPreviewTruncated).toBe(true);
  });

  it("includeBodyJson=false omite bodyJson", () => {
    const raw = JSON.stringify({ a: { long: "x".repeat(200) } });
    const p = buildBodyPresentation(raw, {
      includeBodyJson: false,
      maxBodyChars: 10,
    });
    expect(p.bodyJson).toBeUndefined();
    expect(p.bodyPreviewTruncated).toBe(true);
  });
});
