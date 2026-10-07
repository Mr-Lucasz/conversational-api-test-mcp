import { describe, expect, it, vi } from "vitest";
import {
  buildInterpolationContext,
  formatDatePattern,
  interpolateString,
  resolveContextValue,
} from "../src/http/VariableInterpolator.js";

describe("VariableInterpolator", () => {
  it("overlays env.local over yaml for same key", () => {
    const ctx = buildInterpolationContext(
      { token: "from-yaml" },
      { token: "from-local" },
      {},
    );
    expect(interpolateString("{{token}}", ctx)).toBe("from-local");
  });

  it("resolves env.NAME via process.env when listed in MCP_API_ENV_PASSTHROUGH", () => {
    const prev = process.env.FOO_TEST_MCP;
    process.env.FOO_TEST_MCP = "bar";
    process.env.MCP_API_ENV_PASSTHROUGH = "FOO_TEST_MCP";
    const ctx = buildInterpolationContext({}, {}, {});
    expect(interpolateString("{{env.FOO_TEST_MCP}}", ctx)).toBe("bar");
    delete process.env.MCP_API_ENV_PASSTHROUGH;
    if (prev === undefined) {
      delete process.env.FOO_TEST_MCP;
    } else {
      process.env.FOO_TEST_MCP = prev;
    }
  });

  it("leaves env.NAME as literal placeholder when process.env missing", () => {
    const prev = process.env.FOO_TEST_MCP_MISSING_XYZ;
    delete process.env.FOO_TEST_MCP_MISSING_XYZ;
    const ctx = buildInterpolationContext({}, {}, {});
    expect(interpolateString("{{env.FOO_TEST_MCP_MISSING_XYZ}}", ctx)).toBe(
      "{{env.FOO_TEST_MCP_MISSING_XYZ}}",
    );
    if (prev !== undefined) {
      process.env.FOO_TEST_MCP_MISSING_XYZ = prev;
    }
  });

  it("expands $uuid macro", () => {
    const ctx = buildInterpolationContext({}, {}, {});
    const s = interpolateString("id-{{$uuid}}", ctx);
    expect(s).toMatch(
      /^id-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("two $uuid placeholders in one string differ", () => {
    const ctx = buildInterpolationContext({}, {}, {});
    const s = interpolateString("{{$uuid}}|{{$uuid}}", ctx);
    const [a, b] = s.split("|");
    expect(a).not.toBe(b);
  });

  it("expands $timestamp as Unix ms string", () => {
    const ctx = buildInterpolationContext({}, {}, {});
    const s = interpolateString("{{$timestamp}}", ctx);
    expect(s).toMatch(/^\d{13,}$/);
    expect(Number(s)).toBeLessThanOrEqual(Date.now());
  });

  it("expands $date and $date:FORMAT with fixed clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T14:30:00.000Z"));
    const ctx = buildInterpolationContext({}, {}, {});
    const now = new Date();
    expect(interpolateString("{{$date}}", ctx)).toBe(
      formatDatePattern("YYYY-MM-DD", now),
    );
    expect(interpolateString("{{$date:YYYY-MM-DD}}", ctx)).toBe(
      formatDatePattern("YYYY-MM-DD", now),
    );
    vi.useRealTimers();
  });

  it("resolves yaml variable that contains a macro in a second pass", () => {
    const ctx = buildInterpolationContext(
      { trace: "TESTE-{{$uuid}}" },
      {},
      {},
    );
    const out = interpolateString("x={{trace}}", ctx);
    expect(out).toMatch(/^x=TESTE-[0-9a-f-]{36}$/i);
  });

  it("formatDatePattern supports tokens", () => {
    const d = new Date("2026-01-07T08:09:10.011Z");
    expect(formatDatePattern("YYYY-MM-DD", d)).toBe("2026-01-07");
    expect(formatDatePattern("HH:mm:ss.SSS", d)).toMatch(
      /^\d{2}:\d{2}:\d{2}\.\d{3}$/,
    );
  });

  it("resolveContextValue uses CURRENT_ENV prefix for BASE_URL-style keys", () => {
    const ctx = buildInterpolationContext(
      {},
      {
        STAGING_BASE_URL: "https://staging.example",
        BASE_URL: "",
      },
      { CURRENT_ENV: "staging" },
    );
    expect(resolveContextValue("BASE_URL", ctx)).toBe("https://staging.example");
    expect(interpolateString("{{BASE_URL}}/api", ctx)).toBe(
      "https://staging.example/api",
    );
  });

  it("resolveContextValue prefers prefixed over generic when CURRENT_ENV is set", () => {
    const ctx = buildInterpolationContext(
      {},
      { STAGING_BASE_URL: "https://prefixed", BASE_URL: "https://direct" },
      { CURRENT_ENV: "STAGING" },
    );
    expect(resolveContextValue("BASE_URL", ctx)).toBe("https://prefixed");
  });

  it("resolveContextValue returns literal {{KEY}} when nothing resolves", () => {
    const ctx = buildInterpolationContext({}, {}, { CURRENT_ENV: "STAGING" });
    expect(resolveContextValue("CLIENT_ID", ctx)).toBe("{{CLIENT_ID}}");
    expect(interpolateString("x={{CLIENT_ID}}", ctx)).toBe("x={{CLIENT_ID}}");
  });
});
