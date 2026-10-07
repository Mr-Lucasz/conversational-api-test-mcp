import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { fetchPlain } from "../src/http/fetchPlain.js";
import {
  maskIfSensitive,
  redactHeaders,
  redactJsonValue,
  redactUrl,
} from "../src/http/redact.js";
import { resolveUrl } from "../src/http/resolveRequestUrl.js";
import { executeEndpointById } from "../src/http/runEndpoint.js";
import {
  buildInterpolationContext,
  interpolateString,
} from "../src/http/VariableInterpolator.js";
import { getSessionVariable } from "../src/session/SessionStore.js";
import { dryRunRequestHandler } from "../src/tools/dryRunRequest.js";
import { executeApiFlowHandler } from "../src/tools/executeApiFlow.js";
import { getEnvironmentVariableHandler } from "../src/tools/getEnvironmentVariable.js";

const DEF = ".mcp/api/def.yaml";

function workspaceWith(yaml: string[], envLocal?: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-hardening-"));
  mkdirSync(join(root, ".mcp", "api"), { recursive: true });
  writeFileSync(join(root, DEF), yaml.join("\n"));
  if (envLocal) {
    writeFileSync(join(root, ".env.mcp.local"), envLocal.join("\n"));
  }
  return root;
}

const AUTH_CHAIN = [
  "version: '1'",
  "base_url: http://example.test",
  "endpoints:",
  "  - id: get_token",
  "    method: POST",
  "    path: /token",
  "    capture:",
  "      access_token: $.access_token",
  "      user_id: $.user_id",
  "  - id: list_things",
  "    method: GET",
  "    path: /list",
  "    auth: Bearer {{access_token}}",
  "    auth_dependency: get_token",
  "    assert:",
  "      status: 200",
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const origFetch = globalThis.fetch;
const ENV_KEYS = [
  "MCP_API_ALLOWED_HOSTS",
  "MCP_API_ENV_PASSTHROUGH",
  "MCP_API_MAX_RESPONSE_BYTES",
  "HARDENING_TEST_SECRET",
];

afterEach(() => {
  globalThis.fetch = origFetch;
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
  vi.restoreAllMocks();
});

describe("resolveUrl", () => {
  it("keeps the path prefix of base_url", () => {
    expect(resolveUrl("https://api.example.com/v1", "/users")).toBe(
      "https://api.example.com/v1/users",
    );
    expect(resolveUrl("https://api.example.com/v1/", "users")).toBe(
      "https://api.example.com/v1/users",
    );
  });

  it("joins a bare host and lets an absolute path win", () => {
    expect(resolveUrl("https://api.example.com", "/users")).toBe(
      "https://api.example.com/users",
    );
    expect(resolveUrl("https://api.example.com/v1", "https://other.test/x")).toBe(
      "https://other.test/x",
    );
  });
});

describe("runEndpoint hardening", () => {
  it("refreshes auth on 401 even when the endpoint has an assert", async () => {
    const ws = workspaceWith(AUTH_CHAIN);
    let tokenCalls = 0;
    let listCalls = 0;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const u = input.toString();
      if (u.includes("/token")) {
        tokenCalls += 1;
        return Promise.resolve(
          json({ access_token: `tok${tokenCalls}`, user_id: "u-42" }),
        );
      }
      listCalls += 1;
      return Promise.resolve(listCalls === 1 ? json({}, 401) : json([]));
    }) as typeof fetch;

    const r = await executeEndpointById({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      requestId: "list_things",
    });

    expect(r.ok).toBe(true);
    expect(tokenCalls).toBe(2);
    expect(listCalls).toBe(2);
  });

  it("masks captured credentials in the output but keeps them in the session", async () => {
    const ws = workspaceWith(AUTH_CHAIN);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(json({ access_token: "s3cr3t-token", user_id: "u-42" })),
    ) as typeof fetch;

    const r = await executeEndpointById({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      requestId: "get_token",
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.captureApplied).toEqual({
        access_token: "[REDACTED]",
        user_id: "u-42",
      });
      expect(JSON.stringify(r)).not.toContain("s3cr3t-token");
    }
    expect(getSessionVariable(ws, "access_token")).toBe("s3cr3t-token");

    const shown = decode(
      (
        await getEnvironmentVariableHandler({
          workspaceRoot: ws,
          name: "access_token",
        })
      ).content[0].text,
    ) as Record<string, unknown>;
    expect(shown.value).toBe("[REDACTED]");
    expect(shown.masked).toBe(true);
  });

  it("times out while the body is still streaming", async () => {
    const ws = workspaceWith(AUTH_CHAIN);
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(new Error("aborted")),
          );
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as typeof fetch;

    const r = await executeEndpointById({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      requestId: "get_token",
      timeoutMs: 50,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/timed out after 50ms/);
    }
  });

  it("rejects a body larger than MCP_API_MAX_RESPONSE_BYTES", async () => {
    process.env.MCP_API_MAX_RESPONSE_BYTES = "16";
    const ws = workspaceWith(AUTH_CHAIN);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("x".repeat(64), { status: 200 })),
    ) as typeof fetch;

    const r = await executeEndpointById({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      requestId: "get_token",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/exceeds 16 bytes/);
    }
  });
});

describe("host allowlist across redirects", () => {
  const input = {
    url: "https://ok.test/start",
    method: "GET" as const,
    headers: { Authorization: "Bearer abc" },
    body: undefined,
    signal: new AbortController().signal,
  };

  it("blocks a redirect to a host outside the allowlist", async () => {
    process.env.MCP_API_ALLOWED_HOSTS = "ok.test";
    const calls: string[] = [];
    globalThis.fetch = vi.fn((u: RequestInfo | URL) => {
      calls.push(u.toString());
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.test/steal" },
        }),
      );
    }) as typeof fetch;

    await expect(fetchPlain(input)).rejects.toThrow(/evil\.test/);
    expect(calls).toEqual(["https://ok.test/start"]);
  });

  it("follows an allowed cross-origin redirect without the Authorization header", async () => {
    process.env.MCP_API_ALLOWED_HOSTS = "ok.test,cdn.ok.test";
    const seen: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn((u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return Promise.resolve(
        u.toString().includes("/start")
          ? new Response(null, {
              status: 307,
              headers: { Location: "https://cdn.ok.test/final" },
            })
          : new Response("done", { status: 200 }),
      );
    }) as typeof fetch;

    const res = await fetchPlain(input);
    expect(res.status).toBe(200);
    expect(seen[0].Authorization).toBe("Bearer abc");
    expect(seen[1].Authorization).toBeUndefined();
  });
});

describe("interpolation hardening", () => {
  it("does not expose process.env implicitly or via env. without passthrough", () => {
    process.env.HARDENING_TEST_SECRET = "from-shell";
    const ctx = buildInterpolationContext({}, {}, {});
    expect(interpolateString("{{HARDENING_TEST_SECRET}}", ctx)).toBe(
      "{{HARDENING_TEST_SECRET}}",
    );
    expect(interpolateString("{{env.HARDENING_TEST_SECRET}}", ctx)).toBe(
      "{{env.HARDENING_TEST_SECRET}}",
    );
  });

  it("exposes env.NAME only for names in MCP_API_ENV_PASSTHROUGH", () => {
    process.env.HARDENING_TEST_SECRET = "from-shell";
    process.env.MCP_API_ENV_PASSTHROUGH = "OTHER, HARDENING_*";
    const ctx = buildInterpolationContext({}, {}, {});
    expect(interpolateString("{{env.HARDENING_TEST_SECRET}}", ctx)).toBe(
      "from-shell",
    );
    expect(interpolateString("{{env.PATH}}", ctx)).toBe("{{env.PATH}}");
  });

  it("inserts session values literally instead of re-expanding them", () => {
    const ctx = buildInterpolationContext(
      { greeting: "hi {{name}}" },
      { API_KEY: "local-secret" },
      { name: "{{API_KEY}}" },
    );
    expect(interpolateString("{{greeting}}", ctx)).toBe("hi {{API_KEY}}");
  });
});

describe("redaction helpers", () => {
  it("redacts sensitive keys deeply and JWT-looking strings", () => {
    const { value, changed } = redactJsonValue({
      user: "ana",
      password: "hunter2",
      tokens: { access: "abc", ttl: 60 },
      items: [{ note: "eyJhbGciOi.eyJzdWIiOi.c2ln" }],
    });
    expect(changed).toBe(true);
    expect(value).toEqual({
      user: "ana",
      password: "[REDACTED]",
      tokens: { access: "[REDACTED]", ttl: "[REDACTED]" },
      items: [{ note: "[REDACTED]" }],
    });
  });

  it("leaves non-sensitive data alone", () => {
    const data = { id: 1, name: "ana", tags: ["a"] };
    expect(redactJsonValue(data)).toEqual({ value: data, changed: false });
    expect(maskIfSensitive("order_id", "A-1")).toBe("A-1");
    expect(redactUrl("https://x.test/a?page=2")).toBe("https://x.test/a?page=2");
  });

  it("redacts auth headers but not CORS policy headers", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc",
        "x-auth-token": "abc",
        "access-control-allow-credentials": "true",
        "content-type": "application/json",
      }),
    ).toEqual({
      Authorization: "[REDACTED]",
      "x-auth-token": "[REDACTED]",
      "access-control-allow-credentials": "true",
      "content-type": "application/json",
    });
  });

  it("redacts credential query parameters", () => {
    expect(redactUrl("https://x.test/a?api_key=abc&page=2")).toBe(
      "https://x.test/a?api_key=REDACTED&page=2",
    );
  });
});

describe("dry_run_request with JSON body", () => {
  it("redacts credentials in body and query string", async () => {
    const ws = workspaceWith(
      [
        "version: '1'",
        "base_url: http://example.test/v1",
        "endpoints:",
        "  - id: login",
        "    method: POST",
        "    path: /login?api_key={{API_KEY}}",
        "    body:",
        "      username: ana",
        "      password: \"{{PASSWORD}}\"",
      ],
      ["API_KEY=key-123", "PASSWORD=hunter2"],
    );

    const out = decode(
      (
        await dryRunRequestHandler({
          workspaceRoot: ws,
          definitionRelativePath: DEF,
          requestId: "login",
        })
      ).content[0].text,
    ) as Record<string, string>;

    expect(out.url).toBe("http://example.test/v1/login?api_key=REDACTED");
    expect(out.bodyPreview).toContain('"username":"ana"');
    expect(out.bodyPreview).toContain('"password":"[REDACTED]"');
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("key-123");
  });
});

describe("endpoint params", () => {
  it("are sent as the query string, interpolated", async () => {
    const ws = workspaceWith([
      "version: '1'",
      "base_url: http://example.test/v1",
      "variables:",
      "  city: sao paulo",
      "endpoints:",
      "  - id: search",
      "    method: GET",
      "    path: /search?lang=pt",
      "    params:",
      "      q: \"{{city}}\"",
      "      page: '2'",
    ]);
    let seen = "";
    globalThis.fetch = vi.fn((u: RequestInfo | URL) => {
      seen = u.toString();
      return Promise.resolve(json({}));
    }) as typeof fetch;

    const r = await executeEndpointById({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      requestId: "search",
    });

    expect(r.ok).toBe(true);
    expect(seen).toBe(
      "http://example.test/v1/search?lang=pt&q=sao+paulo&page=2",
    );
  });
});

describe("execute_api_flow by flowName", () => {
  const FLOW_DEF = [
    "version: '1'",
    "base_url: http://example.test",
    "flows:",
    "  smoke:",
    "    steps:",
    "      - ping",
    "      - requestId: status",
    "        assert:",
    "          jsonPathExists: $.ready",
    "endpoints:",
    "  - id: ping",
    "    method: GET",
    "    path: /ping",
    "  - id: status",
    "    method: GET",
    "    path: /status",
  ];

  it("runs the steps declared in the definition", async () => {
    const ws = workspaceWith(FLOW_DEF);
    const calls: string[] = [];
    globalThis.fetch = vi.fn((u: RequestInfo | URL) => {
      calls.push(new URL(u.toString()).pathname);
      return Promise.resolve(json({ ready: true }));
    }) as typeof fetch;

    const res = await executeApiFlowHandler({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      flowName: "smoke",
    });
    const body = decode(res.content[0].text) as {
      ok: boolean;
      summary: { okSteps: number };
    };

    expect(res.isError).toBeFalsy();
    expect(body.ok).toBe(true);
    expect(body.summary.okSteps).toBe(2);
    expect(calls).toEqual(["/ping", "/status"]);
  });

  it("reports an unknown flow and a missing steps/flowName", async () => {
    const ws = workspaceWith(FLOW_DEF);
    const unknown = await executeApiFlowHandler({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      flowName: "nope",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("available: smoke");

    const neither = await executeApiFlowHandler({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
    });
    expect(neither.isError).toBe(true);
  });
});
