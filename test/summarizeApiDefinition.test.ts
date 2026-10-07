import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import {
  summarizeApiDefinitionHandler,
} from "../src/tools/summarizeApiDefinition.js";

describe("summarizeApiDefinitionHandler", () => {
  it("returns names_only by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-summarize-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "example.yaml"),
      [
        "version: '1'",
        "service: example-service",
        "base_url: http://example.test",
        "variables:",
        "  A: x",
        "  B: y",
        "tags: [smoke]",
        "flows:",
        "  smoke_flow:",
        "    description: Smoke flow",
        "    steps: [ep1]",
        "endpoints:",
        "  - id: ep1",
        "    method: GET",
        "    path: /p1",
        "    description: ep1 desc",
        "  - id: ep2",
        "    method: POST",
        "    path: /p2",
      ].join("\n") + "\n",
    );

    const res = await summarizeApiDefinitionHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/example.yaml",
    });

    const body = decode(res.content[0].text) as any;
    expect(body.service).toBe("example-service");
    expect(body.base_url).toBe("http://example.test");
    expect(body.variableKeys.sort()).toEqual(["A", "B"]);
    expect(body.endpointCount).toBe(2);
    expect(body.tags).toEqual(["smoke"]);
    expect(body.flowNames).toEqual(["smoke_flow"]);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints.map((e: any) => e.id).sort()).toEqual(["ep1", "ep2"]);
    expect(body.endpoint).toBeNull();
  });

  it("selects endpoint when requestId is provided", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-summarize2-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "example.yaml"),
      [
        "version: '1'",
        "endpoints:",
        "  - id: ep1",
        "    method: GET",
        "    path: /p1",
      ].join("\n") + "\n",
    );

    const res = await summarizeApiDefinitionHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/example.yaml",
      requestId: "ep1",
    });

    const body = decode(res.content[0].text) as any;
    expect(body.endpoint).not.toBeNull();
    expect(body.endpoint.id).toBe("ep1");
    expect(body.endpoint.method).toBe("GET");
  });

  it("fields projeta cada item de endpoints", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-summarize-fields-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "example.yaml"),
      [
        "version: '1'",
        "endpoints:",
        "  - id: ep1",
        "    method: GET",
        "    path: /p1",
        "    description: a long description nobody needs in triage",
      ].join("\n") + "\n",
    );

    const res = await summarizeApiDefinitionHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/example.yaml",
      fields: ["id", "method"],
    });

    const body = decode(res.content[0].text) as any;
    expect(body.endpoints).toEqual([{ id: "ep1", method: "GET" }]);
  });
});

