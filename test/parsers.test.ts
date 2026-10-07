import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseLegacyToCanonical } from "../src/conversion/ParserFactory.js";
import { parseApiDefinitionYaml } from "../src/canonical/io.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "fixtures");

describe("legacy parsers", () => {
  it("imports Postman minimal", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtures, "postman-minimal.json"), "utf8"),
    ) as unknown;
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    expect(r.canonical.endpoints.length).toBe(1);
    expect(r.canonical.endpoints[0].method).toBe("GET");
    expect(r.losses.length).toBe(0);
  });

  it("reports smart losses for Postman collection scripts", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtures, "postman-with-scripts.json"), "utf8"),
    ) as unknown;
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    const codes = r.losses.map((l) => l.code);
    expect(codes).toContain("POSTMAN_PRE_REQUEST_SCRIPTS");
    expect(codes).toContain("POSTMAN_TESTS");
    const pre = r.losses.find((l) => l.code === "POSTMAN_PRE_REQUEST_SCRIPTS");
    expect(pre?.message).toMatch(/\{\{\$uuid\}\}/);
    expect(pre?.message).toMatch(/auth_dependency/i);
  });

  it("imports OpenAPI minimal", () => {
    const raw = parseYaml(
      readFileSync(join(fixtures, "openapi-minimal.yaml"), "utf8"),
    );
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    expect(r.canonical.endpoints.some((e) => e.path === "/ping")).toBe(true);
  });

  it("imports Insomnia v4 minimal", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtures, "insomnia-export-v4-minimal.json"), "utf8"),
    ) as unknown;
    const r = parseLegacyToCanonical(raw, { serviceName: "t" });
    expect(r.canonical.endpoints.length).toBe(1);
  });
});

describe("canonical YAML", () => {
  it("parses canonical-minimal", () => {
    const raw = readFileSync(join(fixtures, "canonical-minimal.yaml"), "utf8");
    const def = parseApiDefinitionYaml(raw);
    expect(def.endpoints[0].id).toBe("get_uuid");
  });
});
