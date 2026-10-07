import { describe, expect, it } from "vitest";
import { redactHeaders, truncateBody } from "../src/http/redact.js";

describe("redact", () => {
  it("redacts authorization", () => {
    const h = redactHeaders({ Authorization: "Bearer secret", "X-Ok": "1" });
    expect(h.Authorization).toBe("[REDACTED]");
    expect(h["X-Ok"]).toBe("1");
  });

  it("truncates long body", () => {
    const t = "x".repeat(100);
    expect(truncateBody(t, 20).length).toBeLessThan(t.length);
  });

  it("does not split a surrogate pair (emoji) at the truncation boundary", () => {
    const emoji = "\u{1F600}"; // 😀 — 2 UTF-16 code units
    const body = "x".repeat(19) + emoji + "y".repeat(20); // emoji straddles maxChars=20
    const out = truncateBody(body, 20);
    // A saída nunca deve terminar (na parte antes do marcador) num high surrogate solto.
    const kept = out.split("\n")[0];
    const lastCode = kept.charCodeAt(kept.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
    expect(() => JSON.stringify(kept)).not.toThrow();
  });
});
