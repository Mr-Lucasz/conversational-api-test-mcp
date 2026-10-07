import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { reorganizeMcpApiDefinitionsHandler } from "../src/tools/reorganizeMcpApiDefinitions.js";

describe("reorganizeMcpApiDefinitionsHandler", () => {
  it("plan manual_groups returns groups", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-reorg-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(
      join(api, "one.yaml"),
      "version: '1'\nservice: shared\nbase_url: '{{U}}'\nendpoints:\n  - id: e1\n    method: GET\n    path: /1\n",
    );
    writeFileSync(
      join(api, "two.yaml"),
      "version: '1'\nservice: shared\nbase_url: '{{U}}'\nendpoints:\n  - id: e2\n    method: GET\n    path: /2\n",
    );

    const res = await reorganizeMcpApiDefinitionsHandler({
      workspaceRoot: root,
      mode: "plan",
      groupBy: "manual_groups",
      manualGroups: [
        {
          targetRelativePath: ".mcp/api/out.yaml",
          sourceGlobs: ["one.yaml", "two.yaml"],
        },
      ],
    });
    expect(res.isError).toBeFalsy();
    const body = decode(res.content[0].text);
    expect(body.mode).toBe("plan");
    expect(body.groups[0].ready).toBe(true);
    expect(body.groups[0].mergedEndpointCount).toBe(2);
  });

  it("apply writes merged target with confirm", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-reorg2-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(
      join(api, "x.yaml"),
      "version: '1'\nservice: s\nbase_url: '{{U}}'\nendpoints:\n  - id: xa\n    method: GET\n    path: /xa\n",
    );
    writeFileSync(
      join(api, "y.yaml"),
      "version: '1'\nservice: s\nbase_url: '{{U}}'\nendpoints:\n  - id: yb\n    method: GET\n    path: /yb\n",
    );

    const res = await reorganizeMcpApiDefinitionsHandler({
      workspaceRoot: root,
      mode: "apply",
      confirm: true,
      groupBy: "manual_groups",
      manualGroups: [
        {
          targetRelativePath: ".mcp/api/merged.yaml",
          sourceGlobs: ["x.yaml", "y.yaml"],
        },
      ],
    });
    expect(res.isError).toBeFalsy();
    const body = decode(res.content[0].text);
    expect(body.mode).toBe("apply");
    expect(body.writtenTargets).toContain(".mcp/api/merged.yaml");
    const merged = readFileSync(join(api, "merged.yaml"), "utf8");
    expect(merged).toContain("xa");
    expect(merged).toContain("yb");
  });

  it("same_service_field plan finds two-file group", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-reorg3-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(
      join(api, "p.yaml"),
      "version: '1'\nservice: weather\nbase_url: '{{B}}'\nendpoints:\n  - id: p1\n    method: GET\n    path: /p1\n",
    );
    writeFileSync(
      join(api, "q.yaml"),
      "version: '1'\nservice: weather\nbase_url: '{{B}}'\nendpoints:\n  - id: q1\n    method: GET\n    path: /q1\n",
    );

    const res = await reorganizeMcpApiDefinitionsHandler({
      workspaceRoot: root,
      mode: "plan",
      groupBy: "same_service_field",
    });
    expect(res.isError).toBeFalsy();
    const body = decode(res.content[0].text);
    const g = body.groups.find(
      (row: { targetRelativePath: string }) =>
        row.targetRelativePath.includes("_consolidated"),
    );
    expect(g).toBeTruthy();
    expect(g.ready).toBe(true);
  });
});
