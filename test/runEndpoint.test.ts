import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseApiDefinitionYaml,
  readApiDefinitionFile,
} from "../src/canonical/io.js";
import { executeEndpointById } from "../src/http/runEndpoint.js";
import {
  clearSessionForTests,
  setSessionVariable,
} from "../src/session/SessionStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const ws = repoRoot;

describe("runEndpoint auth_dependency", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    clearSessionForTests(ws);
    vi.restoreAllMocks();
  });

  it("parses capture array form to record", () => {
    const def = readApiDefinitionFile(
      join(repoRoot, "test/fixtures/api-capture-array.yaml"),
    );
    expect(def.endpoints[0].capture).toEqual({ myVar: "$.x" });
  });

  it("runs auth endpoint when session lacks capture vars", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const u = typeof input === "string" ? input : input.toString();
        calls.push(u);
        if (u.includes("/token")) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: "tok1" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (u.includes("/list")) {
          const h = init?.headers;
          let auth: string | null = null;
          if (h instanceof Headers) {
            auth = h.get("Authorization");
          } else if (h && typeof h === "object" && !Array.isArray(h)) {
            auth =
              (h as Record<string, string>).Authorization ??
              (h as Record<string, string>).authorization ??
              null;
          }
          expect(auth).toBe("Bearer tok1");
          return Promise.resolve(new Response("[]", { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected url ${u}`));
      },
    ) as typeof fetch;

    const r = await executeEndpointById({
      workspaceRoot: ws,
      definitionRelativePath: "test/fixtures/api-auth-chain.yaml",
      requestId: "list_things",
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(200);
    }
    expect(calls[0]).toContain("/token");
    expect(calls[1]).toContain("/list");
  });

  it("serializes form: as application/x-www-form-urlencoded", async () => {
    let tokenInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes("/token")) {
          tokenInit = init;
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: "tok-form" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (u.includes("/list")) {
          return Promise.resolve(new Response("[]", { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected url ${u}`));
      },
    ) as typeof fetch;

    const r = await executeEndpointById({
      workspaceRoot: ws,
      definitionRelativePath: "test/fixtures/api-form-token.yaml",
      requestId: "list_things",
    });

    expect(r.ok).toBe(true);
    const h = tokenInit?.headers;
    let ct: string | null = null;
    if (h instanceof Headers) {
      ct = h.get("Content-Type");
    } else if (h && typeof h === "object") {
      ct =
        (h as Record<string, string>)["Content-Type"] ??
        (h as Record<string, string>)["content-type"] ??
        null;
    }
    expect(ct).toContain("application/x-www-form-urlencoded");
    expect(tokenInit?.body).toBe(
      "client_id=cid&client_secret=sec&grant_type=client_credentials",
    );
  });

  it("on 401 clears auth capture vars, refreshes token, retries list once", async () => {
    setSessionVariable(ws, "session_token", "stale");
    let n = 0;
    globalThis.fetch = vi.fn(() => {
      n += 1;
      if (n === 1) {
        return Promise.resolve(new Response("{}", { status: 401 }));
      }
      if (n === 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "fresh" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("[]", { status: 200 }));
    }) as typeof fetch;

    const r = await executeEndpointById({
      workspaceRoot: ws,
      definitionRelativePath: "test/fixtures/api-auth-chain.yaml",
      requestId: "list_things",
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(200);
    }
    expect(n).toBe(3);
  });

  it("detects auth_dependency cycle", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    ) as typeof fetch;

    const r = await executeEndpointById({
      workspaceRoot: ws,
      definitionRelativePath: "test/fixtures/api-auth-cycle.yaml",
      requestId: "ep_a",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/cycle/i);
    }
  });
});

describe("parseApiDefinitionYaml capture preprocess", () => {
  it("accepts array capture via YAML string", () => {
    const yaml = readFileSync(
      join(repoRoot, "test/fixtures/api-capture-array.yaml"),
      "utf8",
    );
    const def = parseApiDefinitionYaml(yaml);
    expect(def.endpoints[0].capture).toEqual({ myVar: "$.x" });
  });
});
