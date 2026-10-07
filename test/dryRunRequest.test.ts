import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { dryRunRequestHandler } from "../src/tools/dryRunRequest.js";

describe("dry_run_request", () => {
  it("interpolates url and redacts Authorization + form secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-dryrun-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(root, ".env.mcp.local"),
      ["TOKEN=super_secret_token", "CLIENT_SECRET=client_secret_value"].join(
        "\n",
      ),
    );

    writeFileSync(
      join(api, "def.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "variables:",
        "  id: '123'",
        "endpoints:",
        "  - id: post",
        "    method: POST",
        "    path: /do/{{id}}",
        "    auth: Bearer {{TOKEN}}",
        "    form:",
        "      client_secret: \"{{CLIENT_SECRET}}\"",
        "      token: \"{{TOKEN}}\"",
        "      grant_type: client_credentials",
      ].join("\n"),
    );

    const out = await dryRunRequestHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/def.yaml",
      requestId: "post",
      maxBodyChars: 8000,
    });


    const body = decode(out.content[0].text) as any;
    expect(body.ok).toBe(true);
    expect(body.url).toContain("/do/123");
    expect(body.requestHeaders.Authorization).toBe("[REDACTED]");
    expect(body.bodyPreview).toContain("client_secret=[REDACTED]");
    expect(body.bodyPreview).toContain("token=[REDACTED]");
    expect(body.bodyPreview).not.toContain("super_secret_token");
    expect(body.bodyPreview).not.toContain("client_secret_value");
  });
});

