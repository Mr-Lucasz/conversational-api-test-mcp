import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { executeApiRequestHandler } from "../src/tools/executeApiRequest.js";
import { executeApiFlowHandler } from "../src/tools/executeApiFlow.js";
import { clearSessionForTests } from "../src/session/SessionStore.js";

describe("benchmarks (proxies de tokens/round-trips)", () => {
  it("responseDetail:minimal reduz tamanho do output vs full", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-metrics-minimal-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "def.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: get_big",
        "    method: GET",
        "    path: /big",
      ].join("\n") + "\n",
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ items: Array.from({ length: 4000 }, (_, i) => i) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const full = await executeApiRequestHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/def.yaml",
      requestId: "get_big",
      responseDetail: "full",
    });
    const minimal = await executeApiRequestHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/def.yaml",
      requestId: "get_big",
      responseDetail: "minimal",
    });

    globalThis.fetch = origFetch;
    clearSessionForTests(root);

    const fullLen = full.content[0].text.length;
    const minimalLen = minimal.content[0].text.length;
    expect(minimalLen).toBeLessThan(fullLen);
  });

  it("execute_api_flow (1 tool call) reduz output vs N execute_api_request", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-metrics-flow-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "def.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: a",
        "    method: GET",
        "    path: /a",
        "  - id: b",
        "    method: GET",
        "    path: /b",
        "  - id: c",
        "    method: GET",
        "    path: /c",
      ].join("\n") + "\n",
    );

    // Corpo realista (não um array vazio): é o cenário em que o flow realmente compensa —
    // ele descarta headers/bodyPreview por step e só devolve status/duração/captures,
    // enquanto cada execute_api_request separado (mesmo em "summary") carrega esse peso.
    const responseBody = JSON.stringify({
      ok: true,
      id: "abc-123",
      createdAt: "2026-08-31T10:00:00Z",
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const separate = await Promise.all([
      executeApiRequestHandler({
        workspaceRoot: root,
        definitionRelativePath: ".mcp/api/def.yaml",
        requestId: "a",
        responseDetail: "summary",
      }),
      executeApiRequestHandler({
        workspaceRoot: root,
        definitionRelativePath: ".mcp/api/def.yaml",
        requestId: "b",
        responseDetail: "summary",
      }),
      executeApiRequestHandler({
        workspaceRoot: root,
        definitionRelativePath: ".mcp/api/def.yaml",
        requestId: "c",
        responseDetail: "summary",
      }),
    ]);

    const separateLen = separate.reduce(
      (acc, r) => acc + r.content[0].text.length,
      0,
    );

    const flow = await executeApiFlowHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/def.yaml",
      steps: [{ requestId: "a" }, { requestId: "b" }, { requestId: "c" }],
      responseDetail: "summary",
      stopOnError: true,
    });

    globalThis.fetch = origFetch;
    clearSessionForTests(root);

    const flowLen = flow.content[0].text.length;
    expect(flowLen).toBeLessThan(separateLen);
  });

  it("jsonPathSelect reduz o corpo devolvido (projeção) quando em summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-metrics-jsonpath-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "def.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: big",
        "    method: GET",
        "    path: /big",
      ].join("\n") + "\n",
    );

    const payload = JSON.stringify({
      items: Array.from({ length: 2000 }, (_, i) => ({
        id: i,
        value: "x".repeat(200),
      })),
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response(payload, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const without = await executeApiRequestHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/def.yaml",
      requestId: "big",
      responseDetail: "summary",
      maxBodyChars: 8000,
    });
    const withProjection = await executeApiRequestHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/def.yaml",
      requestId: "big",
      responseDetail: "summary",
      maxBodyChars: 200,
      jsonPathSelect: "$.items[0].id",
    });

    globalThis.fetch = origFetch;
    clearSessionForTests(root);

    const w1 = decode(without.content[0].text) as any;
    const w2 = decode(withProjection.content[0].text) as any;
    // Estourou o cap: começo truncado + wrapper com as chaves de topo.
    expect(w1.bodyPreviewTruncated).toBe(true);
    expect(w1.bodyJson.topLevelKeys).toEqual(["items"]);
    // A projeção coube: o valor volta uma vez só, em `bodyJson`.
    expect(w2.bodyJson).toBe(0);
    expect(w2).not.toHaveProperty("bodyPreview");
    expect(w2).not.toHaveProperty("bodyPreviewTruncated");
    expect(withProjection.content[0].text.length).toBeLessThan(
      without.content[0].text.length,
    );
  });

  it("summary devolve o corpo uma vez e só os headers que importam", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-metrics-summary-shape-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(
      join(api, "def.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: get_small",
        "    method: GET",
        "    path: /small",
        "  - id: get_html",
        "    method: GET",
        "    path: /html",
      ].join("\n") + "\n",
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      input.toString().endsWith("/html")
        ? new Response("<html>oi</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
        : new Response(JSON.stringify({ id: "abc", deletedAt: null }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Date: "Wed, 07 Oct 2026 19:02:39 GMT",
              Server: "gunicorn",
              "X-RateLimit-Remaining": "41",
            },
          }),
    ) as typeof fetch;

    const run = async (requestId: string, responseDetail: string) =>
      decode(
        (
          await executeApiRequestHandler({
            workspaceRoot: root,
            definitionRelativePath: ".mcp/api/def.yaml",
            requestId,
            responseDetail,
          })
        ).content[0].text,
      ) as Record<string, any>;

    const summary = await run("get_small", "summary");
    const full = await run("get_small", "full");
    const html = await run("get_html", "summary");

    globalThis.fetch = origFetch;
    clearSessionForTests(root);

    // `null` dentro do corpo é dado da API: não pode sumir.
    expect(summary.bodyJson).toEqual({ id: "abc", deletedAt: null });
    expect(summary).not.toHaveProperty("bodyPreview");
    expect(summary).not.toHaveProperty("bodyPreviewTruncated");
    expect(summary.responseHeaders).toEqual({
      "content-type": "application/json",
      "x-ratelimit-remaining": "41",
    });
    expect(Object.keys(full.responseHeaders)).toContain("server");

    expect(html.bodyPreview).toBe("<html>oi</html>");
    expect(html).not.toHaveProperty("bodyJson");
  });

  it("regressão: minimal não reintroduz headers/bodyJson/campos vazios sempre-presentes", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-metrics-minimal-shape-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "def.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: get_small",
        "    method: GET",
        "    path: /small",
      ].join("\n") + "\n",
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "abc" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "req-1",
          "set-cookie": "sid=deadbeef",
        },
      });
    }) as typeof fetch;

    const out = await executeApiRequestHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/def.yaml",
      requestId: "get_small",
      responseDetail: "minimal",
    });

    globalThis.fetch = origFetch;
    clearSessionForTests(root);

    const text = out.content[0].text;
    const body = decode(text) as Record<string, unknown>;

    // Campos que nunca deveriam voltar a aparecer em `minimal` (headers) ou nunca
    // deveriam existir (assertOk é sempre true quando presente — informação zero).
    expect(body).not.toHaveProperty("responseHeaders");
    expect(body).not.toHaveProperty("assertOk");
    expect(body).not.toHaveProperty("bodyPreview");
    expect(body).not.toHaveProperty("bodyJson");
    // Sem captures no endpoint: os campos vazios não devem ser serializados.
    expect(body).not.toHaveProperty("captureApplied");
    expect(body).not.toHaveProperty("captureErrors");
    // TOON usa \n como separador estrutural entre chaves de topo (não é
    // pretty-print evitável como no JSON) — o que importa é não ter indentação
    // extra por aninhamento além do necessário para este shape flat.
    expect(text).not.toMatch(/\n {2,}/);
    // Orçamento absoluto: uma resposta minimal para um payload pequeno não deveria
    // passar de ~120 chars em TOON. Se este teste quebrar por bloat, é sinal de regressão.
    expect(text.length).toBeLessThan(120);
  });
});

