import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { collectAssertFailures } from "../src/assertion/assertResponse.js";
import { snapshotFile } from "../src/assertion/snapshot.js";
import { generateMutants, scoreAssertions } from "../src/quality/mutation.js";
import { mutateAssertionsHandler } from "../src/tools/mutateAssertions.js";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.MCP_UPDATE_SNAPSHOTS;
});

const order = { id: 7, status: "paid", items: [{ sku: "a", qty: 2 }], total: 19.9 };
const response = { status: 200, headers: {}, bodyText: JSON.stringify(order), durationMs: 40 };

function ws(): string {
  return mkdtempSync(join(tmpdir(), "mcp-mut-"));
}

describe("mutation of assertions", () => {
  it("a status-only assert lets most mutations through", () => {
    const r = scoreAssertions(response, [{ status: 200 }]);
    expect(r.total).toBe(generateMutants(response).length);
    expect(r.killed).toBe(2); // status 500 and 404
    expect(r.survivors.map((s) => s.id)).toContain("emptylist:$.items");
    expect(r.survivors.find((s) => s.id === "drop:$.status")?.suggestion).toEqual({
      jsonPathExists: "$.status",
    });
  });

  it("the suggestions, once added, kill their mutants", () => {
    const weak = scoreAssertions(response, [{ status: 200 }]);
    const strong = scoreAssertions(response, [
      { status: 200 },
      ...weak.survivors.map((s) => s.suggestion as object),
    ]);
    expect(strong.survivors).toEqual([]);
    expect(strong.score).toBe(1);
  });

  it("does not score asserts that already fail on the real response", () => {
    const r = scoreAssertions(response, [{ status: 201 }]);
    expect(r.baselineFailures?.[0]).toContain("Expected status 201");
  });

  it("mutate_assertions runs a flow and reports survivors per step", async () => {
    const root = ws();
    mkdirSync(join(root, ".mcp/api"), { recursive: true });
    writeFileSync(
      join(root, ".mcp/api/shop.yaml"),
      [
        "base_url: https://api.example.com",
        "endpoints:",
        "  - id: get_order",
        "    method: GET",
        "    path: /orders/7",
        "    assert:",
        "      status: 200",
        "      checks: [{ path: $.items, minLength: 1 }]",
        "flows:",
        "  read:",
        "    steps: [get_order]",
      ].join("\n"),
    );
    globalThis.fetch = vi.fn(() => Promise.resolve(Response.json(order))) as typeof fetch;
    const out = decode(
      (await mutateAssertionsHandler({ workspaceRoot: root, definitionRelativePath: ".mcp/api/shop.yaml", flowName: "read" }))
        .content[0].text,
    ) as { score: number; steps: Array<{ requestId: string }>; survivors: Array<{ change: string; addToAssert: string }> };
    expect(out.steps[0]?.requestId).toBe("get_order");
    expect(out.score).toBeGreaterThan(0);
    expect(out.score).toBeLessThan(1);
    expect(out.survivors.some((s) => s.change.includes("$.status disappeared"))).toBe(true);
    expect(out.survivors.some((s) => s.change.includes("$.items came back empty"))).toBe(false);
  });
});

describe("snapshot assert", () => {
  it("records on first run, then catches shape drift and ignores data changes", () => {
    const root = ws();
    expect(collectAssertFailures(response, { snapshot: "order" }, root)).toEqual([]);
    expect(existsSync(snapshotFile(root, "order"))).toBe(true);

    const otherData = { ...response, bodyText: JSON.stringify({ ...order, id: 8, total: 5 }) };
    expect(collectAssertFailures(otherData, { snapshot: "order" }, root)).toEqual([]);

    const drift = {
      ...response,
      bodyText: JSON.stringify({ id: "8", status: "paid", items: [{ sku: "a" }], total: 5, coupon: null }),
    };
    const failures = collectAssertFailures(drift, { snapshot: "order" }, root);
    expect(failures).toEqual(
      expect.arrayContaining([
        'snapshot order: $.id: "<number>" → "<string>"',
        "snapshot order: $.items[*].qty: missing (was \"<number>\")",
        "snapshot order: $.coupon: new field null",
      ]),
    );
  });

  it("values mode masks ids and dates and honours ignore", () => {
    const root = ws();
    const spec = { snapshot: { name: "v", mode: "values" as const, ignore: ["$.requestId"] } };
    const body = (status: string, requestId: string) => ({
      ...response,
      bodyText: JSON.stringify({ uid: "3f2b8c1e-1d2a-4b5c-9e8f-0a1b2c3d4e5f", at: "2026-11-11T10:00:00Z", status, requestId }),
    });
    expect(collectAssertFailures(body("paid", "r1"), spec, root)).toEqual([]);
    expect(collectAssertFailures(body("paid", "r2"), spec, root)).toEqual([]);
    expect(collectAssertFailures(body("refunded", "r3"), spec, root)).toEqual([
      'snapshot v: $.status: "paid" → "refunded"',
    ]);
    expect(JSON.parse(readFileSync(snapshotFile(root, "v"), "utf8")).body.uid).toBe("<uuid>");
  });

  it("MCP_UPDATE_SNAPSHOTS rewrites instead of failing; read-only never writes", () => {
    const root = ws();
    expect(collectAssertFailures(response, { snapshot: "u" }, root, { readOnlySnapshots: true })).toEqual([]);
    expect(existsSync(snapshotFile(root, "u"))).toBe(false);
    collectAssertFailures(response, { snapshot: "u" }, root);
    const changed = { ...response, bodyText: JSON.stringify({ other: true }) };
    process.env.MCP_UPDATE_SNAPSHOTS = "1";
    expect(collectAssertFailures(changed, { snapshot: "u" }, root)).toEqual([]);
    delete process.env.MCP_UPDATE_SNAPSHOTS;
    expect(collectAssertFailures(changed, { snapshot: "u" }, root)).toEqual([]);
  });
});
