import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { parseApiDefinitionYaml } from "../src/canonical/io.js";
import { getAllPrompts } from "../src/prompts/index.js";
import { getLastResponse, getSessionVariable } from "../src/session/SessionStore.js";
import {
  planVanderChecksHandler,
  runVanderChecksHandler,
} from "../src/tools/vanderChecks.js";
import { buildVanderPlan } from "../src/vander/plan.js";

const DEF = ".mcp/api/def.yaml";
const YAML = [
  "version: '1'",
  "base_url: http://example.test/v1",
  "endpoints:",
  "  - id: get_token",
  "    method: POST",
  "    path: /token",
  "    capture:",
  "      access_token: $.access_token",
  "  - id: list_orders",
  "    method: GET",
  "    path: /orders",
  "    auth: Bearer {{access_token}}",
  "    auth_dependency: get_token",
  "    capture:",
  "      first_id: $.items[0].id",
  "  - id: create_order",
  "    method: POST",
  "    path: /orders",
  "    auth: Bearer {{access_token}}",
  "    auth_dependency: get_token",
  "    body:",
  "      sku: abc",
  "      quantity: 1",
].join("\n");

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-vander-"));
  mkdirSync(join(root, ".mcp", "api"), { recursive: true });
  writeFileSync(join(root, DEF), YAML);
  return root;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Report = {
  summary: Record<string, number>;
  axes: Array<{
    axis: string;
    checks: Array<{ id: string; result?: string; mode?: string; destructive?: boolean; actual?: string; note?: string }>;
  }>;
};

function checksOf(report: Report): Map<string, Report["axes"][number]["checks"][number]> {
  return new Map(report.axes.flatMap((a) => a.checks).map((c) => [c.id, c]));
}

/** A well-behaved API: bearer `good`, GET/POST on /orders, validates the POST body. */
function wellBehaved(calls: string[]): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith("/token")) {
      return Promise.resolve(json({ access_token: "good" }));
    }
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== "Bearer good") {
      return Promise.resolve(json({ error: "unauthorized" }, 401));
    }
    if (method === "GET" || method === "HEAD") {
      return Promise.resolve(json({ items: [{ id: 7 }] }));
    }
    if (method === "OPTIONS") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(String(init?.body));
      } catch {
        return Promise.resolve(json({ error: "bad json" }, 400));
      }
      const ok = "sku" in body && "quantity" in body;
      return Promise.resolve(ok ? json({ id: 8 }, 201) : json({ error: "invalid" }, 422));
    }
    return Promise.resolve(json({ error: "method not allowed" }, 405));
  }) as typeof fetch;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe("VANDER plan", () => {
  const def = parseApiDefinitionYaml(YAML);
  const byId = (id: string) => def.endpoints.find((e) => e.id === id)!;

  it("covers every applicable axis and only probes undeclared verbs", () => {
    const plan = buildVanderPlan(def, byId("list_orders"));
    expect([...new Set(plan.map((c) => c.axis))]).toEqual(["V", "A", "D", "E", "R"]);
    const verbs = plan.filter((c) => c.axis === "V").map((c) => c.id);
    // /orders declares GET (+ implicit HEAD) and POST.
    expect(verbs).toEqual(["V-options", "V-put", "V-patch", "V-delete"]);
  });

  it("marks every probe of a state-changing endpoint as destructive", () => {
    const plan = buildVanderPlan(def, byId("create_order"));
    const requests = plan.filter((c) => c.kind === "request");
    expect(requests.map((c) => c.id)).toContain("N-drop-sku");
    expect(requests.map((c) => c.id)).toContain("E-malformed-json");
    expect(
      requests
        .filter((c) => c.kind === "request" && !c.destructive)
        .map((c) => c.id),
    ).toEqual(["V-options"]);
  });

  it("plan tool lists auto and manual checks without sending anything", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("no network"))) as typeof fetch;
    const out = await planVanderChecksHandler({
      workspaceRoot: workspace(),
      definitionRelativePath: DEF,
      requestId: "list_orders",
      axes: ["A"],
    });
    const report = decode(out.content[0].text) as Report;
    expect(out.isError).toBeFalsy();
    expect(report.axes.map((a) => a.axis)).toEqual(["A"]);
    expect(report.summary).toEqual({ auto: 2, manual: 2, destructive: 0 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("run_vander_checks", () => {
  it("passes a well-behaved GET endpoint and skips state-changing verbs", async () => {
    const ws = workspace();
    const calls: string[] = [];
    globalThis.fetch = wellBehaved(calls);

    const out = await runVanderChecksHandler({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      requestId: "list_orders",
    });
    const report = decode(out.content[0].text) as Report;
    const checks = checksOf(report);

    expect(out.isError).toBeFalsy();
    expect(report.summary.fail).toBe(0);
    expect(checks.get("A-none")?.result).toBe("pass");
    expect(checks.get("A-invalid")?.result).toBe("pass");
    expect(checks.get("D-baseline")?.result).toBe("pass");
    expect(checks.get("D-captures")?.result).toBe("pass");
    expect(checks.get("R-duration")?.result).toBe("pass");
    expect(checks.get("V-delete")?.result).toBe("skipped");
    expect(calls.some((c) => /^(PUT|PATCH|DELETE) /.test(c))).toBe(false);

    // Probes leave no trace in the session beyond the refreshed credentials.
    expect(getSessionVariable(ws, "first_id")).toBeUndefined();
    expect(getLastResponse(ws)?.bodyText).toContain("access_token");
  });

  it("reports an endpoint that ignores credentials and leaks a stack trace", async () => {
    const ws = workspace();
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/token")) {
        return Promise.resolve(json({ access_token: "good" }));
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth === "Bearer vander-invalid-token") {
        return Promise.resolve(
          new Response("Error\n    at verify (/app/auth.js:10:5)", { status: 500 }),
        );
      }
      return Promise.resolve(json({ items: [] }));
    }) as typeof fetch;

    const report = decode(
      (
        await runVanderChecksHandler({
          workspaceRoot: ws,
          definitionRelativePath: DEF,
          requestId: "list_orders",
          axes: ["A", "D", "E"],
        })
      ).content[0].text,
    ) as Report;
    const checks = checksOf(report);

    expect(checks.get("A-none")?.result).toBe("fail");
    expect(checks.get("A-none")?.actual).toContain("status 200");
    expect(checks.get("A-invalid")?.result).toBe("fail");
    expect(checks.get("D-captures")?.result).toBe("fail");
    expect(checks.get("E-no-5xx")?.result).toBe("fail");
    expect(checks.get("E-no-leak")?.result).toBe("fail");
  });

  it("sends state-changing probes only with includeDestructive", async () => {
    const ws = workspace();
    const calls: string[] = [];
    globalThis.fetch = wellBehaved(calls);
    const args = {
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      requestId: "create_order",
    };

    const safe = checksOf(
      decode((await runVanderChecksHandler(args)).content[0].text) as Report,
    );
    expect(safe.get("D-baseline")?.result).toBe("skipped");
    expect(safe.get("R-duration")?.result).toBe("skipped");
    expect(calls.filter((c) => c === "POST /v1/orders")).toHaveLength(0);

    const full = decode(
      (await runVanderChecksHandler({ ...args, includeDestructive: true }))
        .content[0].text,
    ) as Report;
    const checks = checksOf(full);
    expect(full.summary.fail).toBe(0);
    expect(checks.get("D-baseline")?.result).toBe("pass");
    expect(checks.get("N-drop-sku")?.result).toBe("pass");
    expect(checks.get("E-malformed-json")?.result).toBe("pass");
    expect(checks.get("V-delete")?.result).toBe("pass");
  });
});

describe("vander prompt", () => {
  const prompt = getAllPrompts().find((p) => p.name === "vander")!;

  it("sets the persona and names the six axes in order", () => {
    const text = prompt.build({});
    expect(text).toContain("you are **Vander**");
    const order = ["**V**erbs", "**A**uthorization", "**N**egative", "**D**ata", "**E**rrors", "**R**esponsiveness"];
    const positions = order.map((o) => text.indexOf(o));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain("No target was given");
  });

  it("includes the target when given", () => {
    const text = prompt.build({
      definitionRelativePath: ".mcp/api/weather.yaml",
      requestId: "forecast",
    });
    expect(text).toContain("- definition: .mcp/api/weather.yaml");
    expect(text).toContain("- endpoint: forecast");
  });
});
