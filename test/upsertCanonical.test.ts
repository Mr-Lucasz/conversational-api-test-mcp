import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { upsertCanonicalApiDefinitionHandler } from "../src/tools/upsertCanonicalApiDefinition.js";

describe("upsertCanonicalApiDefinitionHandler", () => {
  it("dryRun append previews merged file", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-upsert-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    const rel = ".mcp/api/t.yaml";
    writeFileSync(
      join(root, rel),
      "version: '1'\nservice: s\nendpoints:\n  - id: old\n    method: GET\n    path: /old\n",
    );

    const res = await upsertCanonicalApiDefinitionHandler({
      workspaceRoot: root,
      targetRelativePath: rel,
      dryRun: true,
      mergeMode: "append_endpoints",
      appendEndpoints: [
        { id: "new", method: "GET", path: "/new" },
      ],
    });
    expect(res.isError).toBeFalsy();
    const body = decode(res.content[0].text);
    expect(body.dryRun).toBe(true);
    expect(body.preview.endpoints.map((e: { id: string }) => e.id)).toEqual([
      "old",
      "new",
    ]);
  });

  it("writes when confirm true and dryRun false", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-upsert2-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    const rel = ".mcp/api/w.yaml";
    writeFileSync(
      join(root, rel),
      "version: '1'\nendpoints:\n  - id: a\n    method: GET\n    path: /a\n",
    );

    const res = await upsertCanonicalApiDefinitionHandler({
      workspaceRoot: root,
      targetRelativePath: rel,
      dryRun: false,
      confirm: true,
      mergeMode: "append_endpoints",
      appendEndpoints: [{ id: "b", method: "POST", path: "/b" }],
    });
    expect(res.isError).toBeFalsy();
    const raw = readFileSync(join(root, rel), "utf8");
    expect(raw).toContain("id: b");
  });
});
