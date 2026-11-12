import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { parse as parseYaml } from "yaml";
import { collectAssertFailures } from "../src/assertion/assertResponse.js";
import { findOperation } from "../src/contract/openapi.js";
import { parseLegacyToCanonical } from "../src/conversion/ParserFactory.js";
import { checkContractDriftHandler } from "../src/tools/checkContractDrift.js";

const SPEC = `
openapi: 3.0.3
info: { title: Pets, version: "1" }
servers: [{ url: https://api.example.com/v1 }]
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/Pet" } }
    post:
      operationId: createPet
      requestBody:
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Pet" }
            example: { id: 1, name: Rex }
      responses:
        "201": { description: created }
  /pets/mine:
    get:
      responses: { "200": { description: ok } }
  /pets/{petId}:
    get:
      operationId: getPet
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Pet" }
        "404": { description: missing }
  /owners:
    get:
      responses: { "200": { description: ok } }
components:
  schemas:
    Pet:
      type: object
      required: [id, name]
      properties:
        id: { type: integer }
        name: { type: string }
`;

const DEF = `
base_url: https://api.example.com/v1
endpoints:
  - id: list
    method: GET
    path: /pets
  - id: one
    method: GET
    path: /pets/{{pet_id}}
  - id: create
    method: POST
    path: /pets
    body: { id: 2, name: Bo }
  - id: legacy
    method: GET
    path: /v0/cats
`;

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-drift-"));
  mkdirSync(join(root, ".mcp/api"), { recursive: true });
  writeFileSync(join(root, "openapi.yaml"), SPEC);
  writeFileSync(join(root, ".mcp/api/pets.yaml"), DEF);
  writeFileSync(join(root, ".env.mcp.local"), "pet_id=9\n");
  return root;
}

describe("findOperation", () => {
  const doc = parseYaml(SPEC);
  it("matches placeholders, literals and the server base path, literal templates first", () => {
    expect(findOperation(doc, "GET", "/pets/{{id}}")?.template).toBe("/pets/{petId}");
    expect(findOperation(doc, "GET", "/v1/pets/7")?.template).toBe("/pets/{petId}");
    expect(findOperation(doc, "GET", "/pets/mine")?.template).toBe("/pets/mine");
    expect(findOperation(doc, "DELETE", "/pets/7")).toBeUndefined();
  });
});

describe("OpenAPI import links the schemas", () => {
  it("turns {param} into placeholders and adds assert.schema and body_schema", () => {
    const r = parseLegacyToCanonical(parseYaml(SPEC), { sourceRelativePath: "openapi.yaml" });
    const byId = new Map(r.canonical.endpoints.map((e) => [e.id, e]));
    expect(byId.get("oas_getPet")?.path).toBe("/pets/{{petId}}");
    expect(byId.get("oas_getPet")?.assert).toEqual({
      status: 200,
      schema: "openapi.yaml#/paths/~1pets~1{petId}/get/responses/200/content/application~1json/schema",
    });
    expect(byId.get("oas_createPet")?.body).toEqual({ id: 1, name: "Rex" });
    expect(byId.get("oas_createPet")?.body_schema).toContain("/requestBody/content/application~1json/schema");
  });

  it("the linked schema really validates a response", () => {
    const root = workspace();
    const r = parseLegacyToCanonical(parseYaml(SPEC), { sourceRelativePath: "openapi.yaml" });
    const assert = r.canonical.endpoints.find((e) => e.id === "oas_getPet")!.assert!;
    const ok = { status: 200, headers: {}, bodyText: '{"id":1,"name":"Rex"}' };
    const bad = { status: 200, headers: {}, bodyText: '{"id":"1"}' };
    expect(collectAssertFailures(ok, assert, root)).toEqual([]);
    expect(collectAssertFailures(bad, assert, root).join(" ")).toContain("name");
  });
});

describe("check_contract_drift", () => {
  it("reports ok, drift, not-in-spec, skipped and uncovered operations", async () => {
    const root = workspace();
    globalThis.fetch = vi.fn((u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.endsWith("/pets")) return Promise.resolve(Response.json([{ id: 1, name: "Rex" }]));
      if (url.endsWith("/pets/9")) return Promise.resolve(Response.json({ id: "9" }));
      return Promise.resolve(Response.json({}, { status: 500 }));
    }) as typeof fetch;
    const out = decode(
      (await checkContractDriftHandler({
        workspaceRoot: root,
        definitionRelativePath: ".mcp/api/pets.yaml",
        openapiRelativePath: "openapi.yaml",
      })).content[0].text,
    ) as {
      summary: Record<string, number>;
      results: Array<{ requestId: string; result: string; detail: string }>;
      notCoveredBySpecOperations: string[];
    };
    const row = (id: string) => out.results.find((r) => r.requestId === id)!;
    expect(row("list").result).toBe("ok");
    expect(row("one").result).toBe("drift");
    expect(row("one").detail).toContain("/id must be integer");
    expect(row("one").detail).toContain("name");
    expect(row("create").result).toBe("skipped");
    expect(row("legacy").result).toBe("not-in-spec");
    expect(out.notCoveredBySpecOperations).toEqual(
      expect.arrayContaining(["GET /pets/mine", "GET /owners"]),
    );
    expect(out.summary).toMatchObject({ ok: 1, drift: 1, notInSpec: 1, skipped: 1 });
  });

  it("flags an undocumented status", async () => {
    const root = workspace();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(Response.json({ error: "boom" }, { status: 503 })),
    ) as typeof fetch;
    const out = decode(
      (await checkContractDriftHandler({
        workspaceRoot: root,
        definitionRelativePath: ".mcp/api/pets.yaml",
        openapiRelativePath: "openapi.yaml",
        requestIds: ["one"],
      })).content[0].text,
    ) as { results: Array<{ result: string; detail: string }> };
    expect(out.results[0]).toMatchObject({ result: "drift", detail: "status 503 is not documented for this operation" });
  });
});
