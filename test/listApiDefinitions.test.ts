import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { listApiDefinitionsHandler } from "../src/tools/listApiDefinitions.js";

describe("listApiDefinitionsHandler", () => {
  it("lists with default glob and sortBy path", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-list-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(join(api, "z.yaml"), "version: '1'\nendpoints: []\n");
    writeFileSync(join(api, "a.yaml"), "version: '1'\nendpoints: []\n");

    const res = await listApiDefinitionsHandler({
      workspaceRoot: root,
    });
    const body = decode(res.content[0].text);
    expect(body.files).toEqual([
      ".mcp/api/a.yaml",
      ".mcp/api/z.yaml",
    ]);
    expect(body.totalMatched).toBe(2);
    expect(body.truncated).toBe(false);
  });

  it("respects maxFiles and reports truncated", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-list2-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(join(api, "b.yaml"), "version: '1'\nendpoints: []\n");
    writeFileSync(join(api, "c.yaml"), "version: '1'\nendpoints: []\n");

    const res = await listApiDefinitionsHandler({
      workspaceRoot: root,
      maxFiles: 1,
      sortBy: "path",
    });
    const body = decode(res.content[0].text);
    expect(body.files.length).toBe(1);
    expect(body.totalMatched).toBe(2);
    expect(body.truncated).toBe(true);
  });

  it("pagina com cursor: nextCursor retoma exatamente de onde parou", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-list-cursor-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    for (const name of ["a", "b", "c", "d", "e"]) {
      writeFileSync(join(api, `${name}.yaml`), "version: '1'\nendpoints: []\n");
    }

    const page1 = await listApiDefinitionsHandler({
      workspaceRoot: root,
      maxFiles: 2,
    });
    const body1 = decode(page1.content[0].text);
    expect(body1.files).toEqual([".mcp/api/a.yaml", ".mcp/api/b.yaml"]);
    expect(body1.truncated).toBe(true);
    expect(body1.nextCursor).toBe("2");

    const page2 = await listApiDefinitionsHandler({
      workspaceRoot: root,
      maxFiles: 2,
      cursor: body1.nextCursor,
    });
    const body2 = decode(page2.content[0].text);
    expect(body2.files).toEqual([".mcp/api/c.yaml", ".mcp/api/d.yaml"]);
    expect(body2.truncated).toBe(true);
    expect(body2.nextCursor).toBe("4");

    const page3 = await listApiDefinitionsHandler({
      workspaceRoot: root,
      maxFiles: 2,
      cursor: body2.nextCursor,
    });
    const body3 = decode(page3.content[0].text);
    expect(body3.files).toEqual([".mcp/api/e.yaml"]);
    expect(body3.truncated).toBe(false);
    expect(body3.nextCursor).toBeUndefined();
  });

  it("fields projeta os itens de entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-list-fields-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(join(api, "a.yaml"), "version: '1'\nservice: orders\nendpoints: []\n");
    writeFileSync(
      join(api, "_catalog.yaml"),
      ["definitions:", "  - path: .mcp/api/a.yaml", "    service: orders", "    summary: Orders API"].join("\n") + "\n",
    );

    const res = await listApiDefinitionsHandler({
      workspaceRoot: root,
      globPattern: "a.yaml",
      includeCatalogMeta: true,
      fields: ["path"],
    });
    const body = decode(res.content[0].text);
    expect(body.entries).toEqual([{ path: ".mcp/api/a.yaml" }]);
  });
});
