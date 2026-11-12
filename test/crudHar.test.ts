import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { clearApiDefinitionCacheForTests, parseApiDefinitionYaml, readApiDefinitionFile } from "../src/canonical/io.js";
import { parseLegacyToCanonical } from "../src/conversion/ParserFactory.js";
import { inferCrudFlows } from "../src/quality/crud.js";
import { runApiFlow, executeApiFlowInputSchema } from "../src/tools/executeApiFlow.js";
import { inferCrudFlowsHandler } from "../src/tools/inferCrudFlows.js";

const DEF = `
base_url: https://api.example.com
endpoints:
  - id: create_pet
    method: POST
    path: /pets
    body: { name: Rex }
  - id: get_pet
    method: GET
    path: /pets/{{pet_id}}
    assert: { status: 200 }
  - id: update_pet
    method: PATCH
    path: /pets/{{pet_id}}
    body: { name: Max }
  - id: delete_pet
    method: DELETE
    path: /pets/{{pet_id}}
  - id: list_owners
    method: GET
    path: /owners
`;

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("CRUD inference", () => {
  it("proposes create → read → update → read → delete → gone", () => {
    const [p] = inferCrudFlows(parseApiDefinitionYaml(DEF));
    expect(p?.flowName).toBe("crud_pets");
    expect(p?.steps).toEqual([
      "create_pet",
      "get_pet",
      "update_pet",
      "get_pet",
      "delete_pet",
      { requestId: "get_pet_after_delete", optional: false, acceptStatus: [404, 410] },
    ]);
    expect(p?.addCapture).toEqual({ endpointId: "create_pet", variable: "pet_id", jsonPath: "$.id" });
    expect(p?.goneEndpoint?.assert).toBeUndefined();
  });

  it("applies the flow, and it catches a delete that does not delete", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-crud-"));
    mkdirSync(join(root, ".mcp/api"), { recursive: true });
    const file = join(root, ".mcp/api/pets.yaml");
    writeFileSync(file, DEF);
    const out = decode(
      (await inferCrudFlowsHandler({ workspaceRoot: root, definitionRelativePath: ".mcp/api/pets.yaml", apply: true }))
        .content[0].text,
    ) as { applied: boolean; backup: string };
    expect(out.applied).toBe(true);
    clearApiDefinitionCacheForTests();
    const written = readApiDefinitionFile(file);
    expect(written.endpoints.find((e) => e.id === "create_pet")?.capture).toEqual({ pet_id: "$.id" });

    const api = (deletes: boolean) => {
      let alive = false;
      return vi.fn((u: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = u.toString();
        if (method === "POST") {
          alive = true;
          return Promise.resolve(Response.json({ id: 42 }, { status: 201 }));
        }
        if (!url.endsWith("/pets/42")) return Promise.resolve(new Response("bad id", { status: 400 }));
        if (method === "DELETE") {
          if (deletes) alive = false;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(alive ? Response.json({ id: 42 }) : Response.json({}, { status: 404 }));
      }) as typeof fetch;
    };
    const run = () =>
      runApiFlow(
        executeApiFlowInputSchema.parse({
          workspaceRoot: root,
          definitionRelativePath: ".mcp/api/pets.yaml",
          flowName: "crud_pets",
        }),
      );
    globalThis.fetch = api(true);
    expect((await run()).ok).toBe(true);
    globalThis.fetch = api(false);
    const broken = await run();
    expect(broken.ok).toBe(false);
    expect(broken.steps.at(-1)).toMatchObject({ requestId: "get_pet_after_delete", ok: false, status: 200 });
  });
});

describe("HAR import", () => {
  const har = {
    log: {
      entries: [
        { request: { method: "GET", url: "https://app.example.com/static/app.js", headers: [] }, response: { status: 200, content: { mimeType: "application/javascript" } } },
        {
          request: {
            method: "POST",
            url: "https://app.example.com/api/login",
            headers: [{ name: "Content-Type", value: "application/json" }, { name: "User-Agent", value: "x" }],
            postData: { mimeType: "application/json", text: '{"user":"ana"}' },
          },
          response: { status: 200, content: { mimeType: "application/json" } },
        },
        {
          request: {
            method: "GET",
            url: "https://app.example.com/api/orders?page=2",
            headers: [{ name: "Authorization", value: "Bearer real-secret" }, { name: "Cookie", value: "sid=abc" }, { name: "X-Tenant", value: "acme" }],
          },
          response: { status: 200, content: { mimeType: "application/json" } },
        },
        { request: { method: "GET", url: "https://app.example.com/api/orders?page=3", headers: [] }, response: { status: 200, content: { mimeType: "application/json" } } },
        { request: { method: "GET", url: "https://analytics.other.com/collect", headers: [] }, response: { status: 204, content: { mimeType: "" } } },
      ],
    },
  };

  it("keeps the API calls of the main host, as endpoints and a recorded flow", () => {
    const r = parseLegacyToCanonical(har);
    expect(r.sourceLabel).toBe("har");
    expect(r.canonical.variables?.base_url).toBe("https://app.example.com");
    const ids = r.canonical.endpoints.map((e) => e.id);
    expect(ids).toEqual(["post_api_login", "get_api_orders"]);
    const orders = r.canonical.endpoints[1]!;
    expect(orders).toMatchObject({ auth: "{{AUTHORIZATION}}", params: { page: "2" }, headers: { Cookie: "{{COOKIE}}", "X-Tenant": "acme" }, assert: { status: 200 } });
    expect(JSON.stringify(r.canonical)).not.toContain("real-secret");
    expect(r.canonical.endpoints[0]).toMatchObject({ body: { user: "ana" } });
    expect(r.canonical.endpoints[0]?.headers).toBeUndefined();
    expect(r.canonical.flows?.recorded?.steps).toEqual(["post_api_login", "get_api_orders", "get_api_orders"]);
    expect(r.losses.map((l) => l.code)).toEqual(["HAR_AUTH", "HAR_OTHER_ORIGINS"]);
  });
});
