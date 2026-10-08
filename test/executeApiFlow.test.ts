import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { executeApiFlowHandler } from "../src/tools/executeApiFlow.js";
import { clearSessionForTests } from "../src/session/SessionStore.js";

describe("execute_api_flow", () => {
  afterEach(() => {
    // Limpa mock e sessão entre testes.
    vi.restoreAllMocks();
  });

  it("executa steps em sequência e respeita stopOnError", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-flow-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "flow.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: first",
        "    method: GET",
        "    path: /first",
        "  - id: second",
        "    method: GET",
        "    path: /second",
      ].join("\n") + "\n",
    );

    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.endsWith("/first")) {
        return new Response("[]", { status: 200 });
      }
      if (url.endsWith("/second")) {
        return new Response("[]", { status: 500 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const out = await executeApiFlowHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/flow.yaml",
      steps: [
        { requestId: "first" },
        { requestId: "second" },
      ],
      stopOnError: true,
      responseDetail: "minimal",
    });


    globalThis.fetch = origFetch;

    const body = decode(out.content[0].text) as any;
    expect(body.ok).toBe(false);
    expect(body.steps.length).toBe(2);
    expect(body.steps[0].ok).toBe(true);
    expect(body.steps[1].ok).toBe(false);
    expect(calls.length).toBe(2);

    clearSessionForTests(root);
  });

  it("reexecuta step com retry até status aceitável", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-flow-retry-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "flow.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: flaky",
        "    method: GET",
        "    path: /flaky",
      ].join("\n") + "\n",
    );

    let n = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/flaky")) {
        n++;
        return new Response("[]", { status: n < 2 ? 500 : 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const out = await executeApiFlowHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/flow.yaml",
      steps: [
        {
          requestId: "flaky",
          retry: { max: 2, delayMs: 0 },
          acceptStatus: [200],
        },
      ],
      responseDetail: "minimal",
    });


    globalThis.fetch = origFetch;

    const body = decode(out.content[0].text) as any;
    expect(body.ok).toBe(true);
    expect(body.steps[0].ok).toBe(true);
    expect(n).toBe(2);
    clearSessionForTests(root);
  });

  it("poll reexecuta até jsonPath existir", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-flow-poll-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "flow.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: poll_ep",
        "    method: GET",
        "    path: /poll",
      ].join("\n") + "\n",
    );

    let n = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/poll")) {
        n++;
        const body = n < 2 ? JSON.stringify({ ready: false }) : JSON.stringify({ ready: true });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const out = await executeApiFlowHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/flow.yaml",
      steps: [
        {
          requestId: "poll_ep",
          poll: { untilJsonPath: "$.ready", maxAttempts: 3, delayMs: 0 },
        },
      ],
      responseDetail: "minimal",
    });


    globalThis.fetch = origFetch;

    const body = decode(out.content[0].text) as any;
    expect(body.ok).toBe(true);
    expect(body.steps[0].ok).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
    clearSessionForTests(root);
  });

  it("assert por step (jsonPathExists) falha o step mesmo com status 2xx", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-flow-assert-fail-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "flow.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: check",
        "    method: GET",
        "    path: /check",
      ].join("\n") + "\n",
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "pending" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const out = await executeApiFlowHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/flow.yaml",
      steps: [
        {
          requestId: "check",
          assert: { jsonPathExists: "$.doneAt" },
        },
      ],
      responseDetail: "minimal",
    });

    globalThis.fetch = origFetch;

    const body = decode(out.content[0].text) as any;
    expect(body.ok).toBe(false);
    expect(body.steps[0].ok).toBe(false);
    expect(String(body.steps[0].errorPreview)).toContain("jsonPathExists");
    clearSessionForTests(root);
  });

  it("assert por step (status + jsonPathExists) passa sem round-trip extra de assert_response", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-flow-assert-ok-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });

    writeFileSync(
      join(api, "flow.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: check",
        "    method: GET",
        "    path: /check",
      ].join("\n") + "\n",
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "done", doneAt: "2026-08-31" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const out = await executeApiFlowHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/flow.yaml",
      steps: [
        {
          requestId: "check",
          assert: { status: 200, jsonPathExists: "$.doneAt" },
        },
      ],
      responseDetail: "minimal",
    });

    globalThis.fetch = origFetch;

    const body = decode(out.content[0].text) as any;
    expect(body.ok).toBe(true);
    expect(body.steps[0].ok).toBe(true);
    clearSessionForTests(root);
  });

  it("responseDetail e jsonPathSelect por step controlam o que volta de cada step", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-flow-detail-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(
      join(api, "flow.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: login",
        "    method: POST",
        "    path: /login",
        "    capture:",
        "      user_id: $.user.id",
        "  - id: orders",
        "    method: GET",
        "    path: /orders",
      ].join("\n") + "\n",
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          input.toString().endsWith("/login")
            ? { user: { id: 7 }, access_token: "secret-token-value" }
            : { items: [{ id: 1 }, { id: 2 }], total: 2 },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;

    const run = async (extra: Record<string, unknown>) =>
      decode(
        (
          await executeApiFlowHandler({
            workspaceRoot: root,
            definitionRelativePath: ".mcp/api/flow.yaml",
            steps: [{ requestId: "login" }, { requestId: "orders" }],
            ...extra,
          })
        ).content[0].text,
      ) as any;

    const minimal = await run({ responseDetail: "minimal" });
    const summary = await run({});
    const perStep = await run({ responseDetail: "per_step" });
    const selected = await run({
      responseDetail: "minimal",
      steps: [
        { requestId: "login" },
        { requestId: "orders", jsonPathSelect: "$.items[*].id" },
      ],
    });

    globalThis.fetch = origFetch;
    clearSessionForTests(root);

    expect(minimal.steps).toEqual([
      { requestId: "login", ok: true, status: 200 },
      { requestId: "orders", ok: true, status: 200 },
    ]);
    expect(minimal.summary.capturedVariables).toEqual(["user_id"]);

    // O default é `summary`: duração e valores capturados, sem corpo.
    expect(summary.steps[0].captureApplied).toEqual({ user_id: "7" });
    expect(summary.steps[0]).toHaveProperty("durationMs");
    expect(summary.steps[1]).not.toHaveProperty("body");

    // `per_step` devolve o corpo de cada step, já redigido.
    expect(perStep.steps[0].body).toEqual({
      user: { id: 7 },
      access_token: "[REDACTED]",
    });
    expect(perStep.steps[1].body.total).toBe(2);

    // `jsonPathSelect` traz só o corpo daquele step, em qualquer nível de detalhe.
    expect(selected.steps[0]).not.toHaveProperty("body");
    expect(selected.steps[1].body).toEqual([1, 2]);
  });

  it("step que falha por status traz errorPreview mesmo em minimal", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-flow-errpreview-"));
    const api = join(root, ".mcp", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(
      join(api, "flow.yaml"),
      [
        "version: '1'",
        "base_url: http://example.test",
        "endpoints:",
        "  - id: boom",
        "    method: GET",
        "    path: /boom",
      ].join("\n") + "\n",
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "db down", token: "abc123secret" }), {
          status: 500,
        }),
    ) as typeof fetch;

    const out = await executeApiFlowHandler({
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/flow.yaml",
      steps: [{ requestId: "boom" }],
      responseDetail: "minimal",
    });

    globalThis.fetch = origFetch;
    clearSessionForTests(root);

    const body = decode(out.content[0].text) as any;
    expect(body.ok).toBe(false);
    expect(body.steps[0].errorPreview).toContain("db down");
    expect(out.content[0].text).not.toContain("abc123secret");
  });
});
