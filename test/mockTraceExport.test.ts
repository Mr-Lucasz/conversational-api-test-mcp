import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { parse as parseYaml } from "yaml";
import { loadRoutes, runMockCli, startMockServer } from "../src/cli/mock.js";
import { jsonPathToPointer } from "../src/contract/export.js";
import { sampleFromSchema } from "../src/contract/sample.js";
import { executeApiFlowInputSchema, runApiFlow } from "../src/tools/executeApiFlow.js";
import { exportContractHandler } from "../src/tools/exportContract.js";

const DEF = `
service: Pets
base_url: "{{base_url}}"
variables: { base_url: "https://api.example.com/v1" }
tracing: { url: "https://apm.example.com/trace/{traceId}" }
endpoints:
  - id: login
    method: POST
    path: /login
    body: { user: ana }
    capture: { token: $.token }
  - id: create_pet
    method: POST
    path: /pets
    auth: Bearer {{token}}
    body: { name: Rex }
    capture: { pet_id: $.id }
    mock: { status: 201, body: { id: 42, name: Rex } }
  - id: get_pet
    method: GET
    path: /pets/{{pet_id}}
    auth: Bearer {{token}}
    assert:
      status: 200
      schema: schemas.yaml#/Pet
  - id: mine
    method: GET
    path: /pets/mine
    mock: { body: [{ id: 1, name: "{{none}}" }] }
flows:
  adopt:
    description: Log in, create a pet and read it back
    steps: [login, create_pet, get_pet]
`;

const SCHEMAS = `
Pet:
  type: object
  required: [id, name]
  properties:
    id: { type: integer, minimum: 1 }
    name: { type: string, example: Rex }
    tags: { type: array, items: { $ref: "#/Tag" } }
    born: { type: string, format: date }
Tag: { type: string, enum: [cute, loud] }
`;

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-mte-"));
  mkdirSync(join(root, ".mcp/api"), { recursive: true });
  writeFileSync(join(root, ".mcp/api/pets.yaml"), DEF);
  writeFileSync(join(root, "schemas.yaml"), SCHEMAS);
  return root;
}

const origFetch = globalThis.fetch;
const servers: Server[] = [];
afterEach(() => {
  globalThis.fetch = origFetch;
  for (const s of servers.splice(0)) s.close();
});

describe("schema samples", () => {
  it("builds a value from types, formats, enums, examples and local refs", () => {
    expect(sampleFromSchema("schemas.yaml#/Pet", workspace())).toEqual({
      id: 1,
      name: "Rex",
      tags: ["cute"],
      born: "2026-01-01",
    });
  });
});

describe("mock server", () => {
  it("answers from mock blocks, schema samples and path params; 404 for the rest", async () => {
    const root = workspace();
    const routes = await loadRoutes(root, []);
    const { server, port } = await startMockServer({ workspaceRoot: root, routes, port: 0 });
    servers.push(server);
    const base = `http://localhost:${port}`;

    const created = await origFetch(`${base}/v1/pets`, { method: "POST", body: "{}" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 42, name: "Rex" });

    const pet = await origFetch(`${base}/pets/7`);
    expect(pet.status).toBe(200);
    expect(await pet.json()).toMatchObject({ id: 1, name: "Rex" });

    const mine = await origFetch(`${base}/pets/mine`);
    expect(await mine.json()).toEqual([{ id: 1, name: "{{none}}" }]);

    const missing = await origFetch(`${base}/owners`);
    expect(missing.status).toBe(404);

    const preflight = await origFetch(`${base}/pets`, { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("the CLI lists the routes and reports usage errors", async () => {
    const root = workspace();
    const out: string[] = [];
    const io = { stdout: (t: string) => void out.push(t), stderr: (t: string) => void out.push(t) };
    const started = await runMockCli(["--workspace", root, "--port", "0"], io);
    if (started.server) servers.push(started.server);
    expect(started.code).toBe(0);
    expect(out.join("")).toContain("mocking 4 endpoints");
    expect((await runMockCli(["--port", "abc"], io)).code).toBe(2);
  });
});

describe("traceparent", () => {
  it("sends a W3C traceparent on every request and reports the trace id per step", async () => {
    const root = workspace();
    const seen: string[] = [];
    globalThis.fetch = vi.fn((u: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>).traceparent ?? "");
      const url = u.toString();
      if (url.endsWith("/login")) return Promise.resolve(Response.json({ token: "t" }));
      if (url.endsWith("/pets")) return Promise.resolve(Response.json({ id: 42 }, { status: 201 }));
      return Promise.resolve(Response.json({ id: "oops" }));
    }) as typeof fetch;
    const result = await runApiFlow(
      executeApiFlowInputSchema.parse({
        workspaceRoot: root,
        definitionRelativePath: ".mcp/api/pets.yaml",
        flowName: "adopt",
      }),
    );
    expect(seen).toHaveLength(3);
    expect(seen.every((t) => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(t))).toBe(true);
    const failed = result.steps.at(-1) as { ok: boolean; traceId: string };
    expect(failed.ok).toBe(false);
    expect(seen[2]).toContain(failed.traceId);
  });
});

describe("export_contract", () => {
  const exportAs = async (root: string, format: string) =>
    decode(
      (await exportContractHandler({ workspaceRoot: root, definitionRelativePath: ".mcp/api/pets.yaml", format }))
        .content[0].text,
    ) as { written: string[]; notes?: string[] };

  it("jsonPathToPointer converts plain paths only", () => {
    expect(jsonPathToPointer("$.data.items[0].id")).toBe("/data/items/0/id");
    expect(jsonPathToPointer("$['a/b']")).toBe("/a~1b");
    expect(jsonPathToPointer("$.items[*].id")).toBeUndefined();
  });

  it("openapi: placeholders become path params, schemas are linked, auth becomes a scheme", async () => {
    const root = workspace();
    const out = await exportAs(root, "openapi");
    expect(out.written).toEqual([".mcp/contracts/pets.openapi.yaml"]);
    const doc = parseYaml(readFileSync(join(root, out.written[0]!), "utf8"));
    expect(doc.servers[0]).toEqual({ url: "{base_url}", variables: { base_url: { default: "https://api.example.com/v1" } } });
    const get = doc.paths["/pets/{pet_id}"].get;
    expect(get.parameters[0]).toMatchObject({ name: "pet_id", in: "path", required: true });
    expect(get.responses["200"].content["application/json"].schema).toEqual({ $ref: "../../schemas.yaml#/Pet" });
    expect(get.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
  });

  it("arazzo: captures become outputs that later steps reference", async () => {
    const root = workspace();
    const out = await exportAs(root, "arazzo");
    expect(out.written).toEqual([".mcp/contracts/pets.openapi.yaml", ".mcp/contracts/pets.arazzo.yaml"]);
    const doc = parseYaml(readFileSync(join(root, out.written[1]!), "utf8"));
    expect(doc.sourceDescriptions).toEqual([{ name: "api", url: "./pets.openapi.yaml", type: "openapi" }]);
    const [wf] = doc.workflows;
    expect(wf.workflowId).toBe("adopt");
    expect(wf.steps.map((s: { stepId: string }) => s.stepId)).toEqual(["login", "create_pet", "get_pet"]);
    expect(wf.steps[1].outputs).toEqual({ pet_id: "$response.body#/id" });
    expect(wf.steps[2].parameters).toEqual([{ name: "pet_id", in: "path", value: "$steps.create_pet.outputs.pet_id" }]);
    expect(wf.steps[1].successCriteria).toEqual([{ condition: "$statusCode == 201" }]);
  });

  it("pact: one interaction per endpoint with type matching on bodies", async () => {
    const root = workspace();
    const out = await exportAs(root, "pact");
    const doc = JSON.parse(readFileSync(join(root, out.written[0]!), "utf8"));
    expect(doc.provider.name).toBe("Pets");
    const get = doc.interactions.find((i: { request: { path: string } }) => i.request.path === "/pets/1");
    expect(get.response.body).toMatchObject({ id: 1, name: "Rex" });
    expect(get.response.matchingRules.body.$.matchers).toEqual([{ match: "type" }]);
    expect(JSON.stringify(doc)).not.toContain("Bearer");
    expect(out.notes?.some((n) => n.startsWith("login:"))).toBe(true);
    const again = await exportContractHandler({ workspaceRoot: root, definitionRelativePath: ".mcp/api/pets.yaml", format: "pact" });
    expect(again.isError).toBe(true);
  });
});
