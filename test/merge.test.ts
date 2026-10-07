import { describe, expect, it } from "vitest";
import { mergeApiDefinitions } from "../src/canonical/merge.js";
import type { ApiDefinitionYaml } from "../src/canonical/schema.js";

const a = (id: string): ApiDefinitionYaml => ({
  version: "1",
  service: "svc",
  base_url: "{{BASE}}",
  variables: { X: "1" },
  endpoints: [{ id, method: "GET", path: "/a" }],
});

describe("mergeApiDefinitions", () => {
  it("merges compatible files", () => {
    const { merged, conflicts } = mergeApiDefinitions([
      { relativePath: "f1.yaml", def: a("e1") },
      { relativePath: "f2.yaml", def: { ...a("e2"), variables: { X: "1" } } },
    ]);
    expect(conflicts).toHaveLength(0);
    expect(merged.endpoints).toHaveLength(2);
    expect(merged.endpoints.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("detects duplicate endpoint id", () => {
    const { conflicts } = mergeApiDefinitions([
      { relativePath: "f1.yaml", def: a("same") },
      { relativePath: "f2.yaml", def: a("same") },
    ]);
    expect(conflicts.some((c) => c.kind === "duplicate_endpoint_id")).toBe(true);
  });

  it("detects base_url mismatch", () => {
    const { conflicts } = mergeApiDefinitions([
      { relativePath: "f1.yaml", def: a("e1") },
      {
        relativePath: "f2.yaml",
        def: { ...a("e2"), base_url: "{{OTHER}}" },
      },
    ]);
    expect(conflicts.some((c) => c.kind === "base_url_mismatch")).toBe(true);
  });
});
