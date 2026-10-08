import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { parseApiDefinitionYaml } from "../src/canonical/io.js";
import { parseCurl, tokenizeShell } from "../src/conversion/curl.js";
import { executeEndpointById } from "../src/http/runEndpoint.js";
import { convertLegacyToCanonicalHandler } from "../src/tools/convertLegacyToCanonical.js";
import { importCurlHandler } from "../src/tools/importCurl.js";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

const ws = () => mkdtempSync(join(tmpdir(), "mcp-import-"));
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const out = (r: { content: Array<{ text: string }> }) =>
  decode(r.content[0].text) as Record<string, any>;

describe("tokenizeShell", () => {
  it("handles quotes, escapes and line continuations", () => {
    expect(
      tokenizeShell(`curl -H 'A: b c' \\\n  -d "{\\"x\\": 1}" $'it\\'s' plain\\ word`),
    ).toEqual(["curl", "-H", "A: b c", "-d", '{"x": 1}', "it's", "plain word"]);
  });
});

describe("parseCurl", () => {
  it("reads a JSON POST and lifts every credential", () => {
    const r = parseCurl(
      `curl -s -X POST 'https://api.example.com/v1/orders?api_key=k-123&page=2' \\
        -H 'Authorization: Bearer tok-abc' -H 'Content-Type: application/json' \\
        -H 'X-Trace: 1' --data-raw '{"sku":"abc","password":"hunter2","qty":2}'`,
      "create_order",
    );
    expect(r.origin).toBe("https://api.example.com");
    expect(r.endpoint).toEqual({
      method: "POST",
      path: "/v1/orders",
      params: { api_key: "{{CREATE_ORDER_API_KEY}}", page: "2" },
      headers: { "Content-Type": "application/json", "X-Trace": "1" },
      auth: "Bearer {{CREATE_ORDER_TOKEN}}",
      body: { sku: "abc", password: "{{CREATE_ORDER_PASSWORD}}", qty: 2 },
    });
    expect(r.secrets).toEqual({
      CREATE_ORDER_API_KEY: "k-123",
      CREATE_ORDER_TOKEN: "tok-abc",
      CREATE_ORDER_PASSWORD: "hunter2",
    });
  });

  it("defaults to GET, turns urlencoded data into a form and -u into basic auth", () => {
    expect(parseCurl("curl https://example.com/ping", "ping").endpoint).toEqual({
      method: "GET",
      path: "/ping",
    });
    const r = parseCurl(
      "curl https://example.com/token -u app:s3cret -d grant_type=client_credentials -d scope=read",
      "get_token",
    );
    expect(r.endpoint).toEqual({
      method: "POST",
      path: "/token",
      auth: "Basic {{GET_TOKEN_BASIC_AUTH}}",
      form: { grant_type: "client_credentials", scope: "read" },
    });
    expect(r.secrets.GET_TOKEN_BASIC_AUTH).toBe(
      Buffer.from("app:s3cret").toString("base64"),
    );
  });

  it("rejects text that is not a curl command", () => {
    expect(() => parseCurl("wget https://example.com", "x")).toThrow(/curl/);
  });
});

describe("import_curl", () => {
  it("creates a runnable definition and keeps the token out of the YAML", async () => {
    const root = ws();
    const result = out(
      await importCurlHandler({
        workspaceRoot: root,
        curl: "curl https://api.example.com/v1/me -H 'Authorization: Bearer tok-abc'",
        requestId: "me",
      }),
    );
    expect(result.created).toBe(true);
    expect(result.secretsMovedToEnvFile).toEqual(["ME_TOKEN"]);

    const yaml = read(root, ".mcp/api/imported.yaml");
    expect(yaml).not.toContain("tok-abc");
    expect(parseApiDefinitionYaml(yaml).endpoints[0]).toMatchObject({
      id: "me",
      method: "GET",
      path: "/v1/me",
      auth: "Bearer {{ME_TOKEN}}",
    });
    expect(read(root, ".env.mcp.local")).toBe("ME_TOKEN=tok-abc\n");
    expect(read(root, ".gitignore")).toBe(".env.mcp.local\n");

    let sent: RequestInit | undefined;
    let url = "";
    globalThis.fetch = vi.fn((u: RequestInfo | URL, init?: RequestInit) => {
      url = u.toString();
      sent = init;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const run = await executeEndpointById({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/imported.yaml",
      requestId: "me",
    });
    expect(run.ok).toBe(true);
    expect(url).toBe("https://api.example.com/v1/me");
    expect((sent?.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
  });

  it("appends to an existing file and refuses a duplicate id", async () => {
    const root = ws();
    const base = { workspaceRoot: root, curl: "curl https://api.example.com/a" };
    await importCurlHandler({ ...base, requestId: "a" });
    const second = out(
      await importCurlHandler({
        workspaceRoot: root,
        curl: "curl https://other.example.com/b",
        requestId: "b",
      }),
    );
    expect(second.created).toBe(false);
    const def = parseApiDefinitionYaml(read(root, ".mcp/api/imported.yaml"));
    expect(def.endpoints.map((e) => e.path)).toEqual([
      "/a",
      "https://other.example.com/b",
    ]);
    const dup = await importCurlHandler({ ...base, requestId: "a" });
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toContain("already exists");
  });
});

describe("convert_legacy_to_canonical", () => {
  const collection = JSON.stringify({
    info: {
      name: "Shop",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "List orders",
        request: {
          method: "GET",
          header: [{ key: "Authorization", value: "Bearer pasted-token" }],
          url: { raw: "https://api.example.com/orders" },
        },
      },
    ],
  });

  it("accepts a pasted collection and moves its token to the env file", async () => {
    const root = ws();
    const result = out(
      await convertLegacyToCanonicalHandler({
        workspaceRoot: root,
        legacyContent: collection,
        outputRelativePath: ".mcp/api/shop.yaml",
      }),
    );
    expect(result.endpointCount).toBe(1);
    const yaml = read(root, ".mcp/api/shop.yaml");
    expect(yaml).not.toContain("pasted-token");
    expect(result.secretsMovedToEnvFile).toHaveLength(1);
    expect(read(root, ".env.mcp.local")).toContain("pasted-token");
  });

  it("does not replace an existing definition unless asked, and stays under .mcp/api", async () => {
    const root = ws();
    const args = {
      workspaceRoot: root,
      legacyContent: collection,
      outputRelativePath: ".mcp/api/shop.yaml",
    };
    await convertLegacyToCanonicalHandler(args);
    const again = await convertLegacyToCanonicalHandler(args);
    expect(again.isError).toBe(true);
    expect((await convertLegacyToCanonicalHandler({ ...args, overwrite: true })).isError).toBeFalsy();

    const outside = await convertLegacyToCanonicalHandler({
      ...args,
      outputRelativePath: "shop.yaml",
    });
    expect(outside.isError).toBe(true);
    expect(existsSync(join(root, "shop.yaml"))).toBe(false);
  });

  it("still converts a file in the workspace", async () => {
    const root = ws();
    writeFileSync(join(root, "shop.postman_collection.json"), collection);
    const result = await convertLegacyToCanonicalHandler({
      workspaceRoot: root,
      legacyRelativePath: "shop.postman_collection.json",
    });
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(root, ".mcp/api/imported.yaml"))).toBe(true);
  });
});
