import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConversationalApiMcpServer } from "../src/server/createServer.js";

type JsonSchema = { properties?: Record<string, unknown>; required?: string[] };

async function rawTools() {
  const server = createConversationalApiMcpServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return (await client.listTools()).tools;
}

async function listTools() {
  const tools = await rawTools();
  return new Map(tools.map((t) => [t.name, t.inputSchema as JsonSchema]));
}

describe("tool surface (o que o cliente vê em tools/list)", () => {
  it("todo tool publica seus parâmetros", async () => {
    // Um schema com .superRefine() chega ao cliente como `properties: {}`.
    for (const [name, schema] of await listTools()) {
      expect(Object.keys(schema.properties ?? {}), name).not.toHaveLength(0);
    }
  });

  it("upsert e reorganize expõem os campos que a descrição manda preencher", async () => {
    const tools = await listTools();
    expect(Object.keys(tools.get("upsert_canonical_api_definition")!.properties!)).toEqual(
      expect.arrayContaining([
        "targetRelativePath",
        "mergeMode",
        "replaceDefinition",
        "appendEndpoints",
        "dryRun",
        "confirm",
      ]),
    );
    expect(Object.keys(tools.get("reorganize_mcp_api_definitions")!.properties!)).toEqual(
      expect.arrayContaining(["mode", "groupBy", "manualGroups", "confirm"]),
    );
  });

  it("a definição tem o mesmo nome de parâmetro em todo tool, e workspaceRoot nunca é obrigatório", async () => {
    for (const [name, schema] of await listTools()) {
      expect(Object.keys(schema.properties ?? {}), name).not.toContain("relativePath");
      expect(schema.required ?? [], name).not.toContain("workspaceRoot");
    }
  });

  it("a lista de tools cabe no orçamento de contexto", async () => {
    const size = JSON.stringify([...(await listTools())]).length;
    // ~4 chars por token: este teto mantém a lista abaixo de ~4,5k tokens por conversa.
    expect(size).toBeLessThan(18_000);
  });

  it("todo tool publica título e annotations, e só leitura não manda HTTP", async () => {
    const tools = await rawTools();
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations?.readOnlyHint, t.name).toBeTypeOf("boolean");
      if (t.annotations?.readOnlyHint) {
        expect(t.annotations.openWorldHint, t.name).toBe(false);
      }
    }
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const name of ["execute_api_request", "execute_api_flow", "run_eval", "run_vander_checks"]) {
      expect(byName.get(name), name).toMatchObject({ openWorldHint: true, destructiveHint: true });
    }
    for (const name of ["dry_run_request", "plan_vander_checks", "summarize_api_definition"]) {
      expect(byName.get(name)?.readOnlyHint, name).toBe(true);
    }
  });
});
