import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { parseApiDefinitionYaml } from "../src/canonical/io.js";
import { runVanderChecksHandler } from "../src/tools/vanderChecks.js";
import { buildVanderPlan } from "../src/vander/plan.js";

const YAML = `
base_url: https://api.example.com
roles:
  bob: Bearer {{BOB_TOKEN}}
  admin: Bearer {{ADMIN_TOKEN}}
endpoints:
  - id: create_user
    method: POST
    path: /users
    auth: Bearer alice
    body: { name: Ana, age: 30, plan: free }
    body_schema: schemas.yaml#/User
  - id: get_order
    method: GET
    path: /orders/{{order_id}}
    auth: Bearer alice
    allow_roles: [admin]
  - id: list_orders
    method: GET
    path: /orders
    auth: Bearer alice
`;

const SCHEMAS = `
User:
  type: object
  additionalProperties: false
  properties:
    name: { $ref: "#/Name" }
    age: { type: integer, minimum: 0, maximum: 130 }
    plan: { type: string, enum: [free, pro] }
Name: { type: string, minLength: 2, maxLength: 40 }
`;

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-neg-"));
  mkdirSync(join(root, ".mcp/api"), { recursive: true });
  writeFileSync(join(root, ".mcp/api/app.yaml"), YAML);
  writeFileSync(join(root, "schemas.yaml"), SCHEMAS);
  writeFileSync(join(root, ".env.mcp.local"), "BOB_TOKEN=bob\nADMIN_TOKEN=admin\norder_id=7\n");
  return root;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

type Report = { checks: Array<{ id: string; result: string; detail: string }> };
const byId = (r: Report) => new Map(r.checks.map((c) => [c.id, c]));

describe("negative probes from body_schema", () => {
  it("derives type, null, boundary, enum and extra-field probes", () => {
    const root = workspace();
    const def = parseApiDefinitionYaml(YAML);
    const ep = def.endpoints[0]!;
    const ids = buildVanderPlan(def, ep, { workspaceRoot: root }).map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "N-type-name",
        "N-null-age",
        "N-empty-name",
        "N-maxlen-name",
        "N-minlen-name",
        "N-max-age",
        "N-min-age",
        "N-enum-plan",
        "N-extra-field",
      ]),
    );
    expect(ids).not.toContain("N-m1");
  });

  it("a strict API passes them and a lax one is caught", async () => {
    const root = workspace();
    const strict = (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const okName = typeof b.name === "string" && b.name.length >= 2 && b.name.length <= 40;
      const okAge = Number.isInteger(b.age) && (b.age as number) >= 0 && (b.age as number) <= 130;
      const okPlan = b.plan === "free" || b.plan === "pro";
      const extra = Object.keys(b).some((k) => !["name", "age", "plan"].includes(k));
      return okName && okAge && okPlan && !extra;
    };
    globalThis.fetch = vi.fn((_u: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? strict(init)
            ? Response.json({ id: 1 }, { status: 201 })
            : Response.json({ error: "invalid" }, { status: 422 })
          : Response.json({}, { status: 405 }),
      ),
    ) as typeof fetch;
    const args = {
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/app.yaml",
      requestId: "create_user",
      axes: ["N"],
      includeDestructive: true,
    };
    const good = byId(decode((await runVanderChecksHandler(args)).content[0].text) as Report);
    expect([...good.values()].filter((c) => c.result === "fail")).toEqual([]);
    expect(good.get("N-max-age")?.result).toBe("pass");

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(Response.json({ id: 1 }, { status: 201 })),
    ) as typeof fetch;
    const lax = byId(decode((await runVanderChecksHandler(args)).content[0].text) as Report);
    expect(lax.get("N-max-age")?.result).toBe("fail");
    expect(lax.get("N-enum-plan")?.result).toBe("fail");
  });
});

describe("BOLA with roles", () => {
  it("probes object endpoints as every role not allowed, and leaves list endpoints alone", () => {
    const def = parseApiDefinitionYaml(YAML);
    const plan = (id: string) =>
      buildVanderPlan(def, def.endpoints.find((e) => e.id === id)!).map((c) => c.id);
    expect(plan("get_order")).toContain("A-role-bob");
    expect(plan("get_order")).not.toContain("A-role-admin");
    expect(plan("list_orders").some((id) => id.startsWith("A-role-"))).toBe(false);
  });

  it("fails when another user reads the object, passes when it is refused", async () => {
    const root = workspace();
    const args = {
      workspaceRoot: root,
      definitionRelativePath: ".mcp/api/app.yaml",
      requestId: "get_order",
      axes: ["A"],
    };
    const seen: string[] = [];
    const api = (leaky: boolean) =>
      vi.fn((_u: RequestInfo | URL, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        seen.push(String(auth));
        if (auth === "Bearer alice" || (leaky && auth === "Bearer bob")) {
          return Promise.resolve(Response.json({ id: 7, owner: "alice" }));
        }
        return Promise.resolve(Response.json({ error: "not found" }, { status: auth ? 404 : 401 }));
      }) as typeof fetch;

    globalThis.fetch = api(false);
    const safe = byId(decode((await runVanderChecksHandler(args)).content[0].text) as Report);
    expect(safe.get("A-role-bob")?.result).toBe("pass");
    expect(seen).toContain("Bearer bob");

    globalThis.fetch = api(true);
    const leaky = byId(decode((await runVanderChecksHandler(args)).content[0].text) as Report);
    expect(leaky.get("A-role-bob")?.result).toBe("fail");
    expect(leaky.get("A-role-bob")?.detail).toContain("status 200");
  });
});
