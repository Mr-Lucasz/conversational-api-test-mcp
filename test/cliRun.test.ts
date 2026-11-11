import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run.js";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

const shop = `
service: Shop
base_url: https://api.example.com
endpoints:
  - id: login
    method: POST
    path: /login
    capture: { TOKEN: $.token }
  - id: orders
    method: GET
    path: /orders
    auth: Bearer {{TOKEN}}
    assert:
      status: 200
      schema: { type: array, items: { type: object, required: [id] } }
  - id: broken
    method: GET
    path: /broken
    assert: { status: 200 }
flows:
  happy:
    steps: [login, orders]
  sad:
    steps: [login, broken]
`;

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-cli-"));
  mkdirSync(join(root, ".mcp/api"), { recursive: true });
  writeFileSync(join(root, ".mcp/api/shop.yaml"), shop);
  writeFileSync(join(root, ".mcp/api/noflows.yaml"), "endpoints: []\n");
  return root;
}

function mockApi(orders: unknown = [{ id: 1 }]) {
  const seen: string[] = [];
  globalThis.fetch = vi.fn((u: RequestInfo | URL, init?: RequestInit) => {
    const url = u.toString();
    seen.push(`${init?.method ?? "GET"} ${url} ${(init?.headers as Record<string, string>)?.Authorization ?? ""}`.trim());
    if (url.endsWith("/login")) return Promise.resolve(Response.json({ token: "t-1" }));
    if (url.endsWith("/orders")) return Promise.resolve(Response.json(orders));
    return Promise.resolve(new Response("boom", { status: 500 }));
  }) as typeof fetch;
  return seen;
}

function capture() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      stdout: (t: string) => void (out.stdout += t),
      stderr: (t: string) => void (out.stderr += t),
    },
  };
}

describe("run (CLI)", () => {
  it("runs every flow, carries captures between steps and exits 1 on a failure", async () => {
    const root = workspace();
    const seen = mockApi();
    const { out, io } = capture();
    const code = await runCli(["--workspace", root], io);
    expect(code).toBe(1);
    expect(seen).toContain("GET https://api.example.com/orders Bearer t-1");
    expect(out.stdout).toContain("✓ Shop › happy");
    expect(out.stdout).toContain("✗ Shop › sad");
    expect(out.stdout).toContain("✗ broken 500");
    expect(out.stdout).toContain("skipped .mcp/api/noflows.yaml: declares no flows");
    expect(out.stdout).toContain("3 passed, 1 failed (2 flows)");
  });

  it("exits 0 when the chosen flow passes, and writes JUnit XML", async () => {
    const root = workspace();
    mockApi();
    const { out, io } = capture();
    const report = join(root, "reports/junit.xml");
    const code = await runCli(
      ["--workspace", root, "--flow", "happy", "--reporter", "junit", "--out", report],
      io,
    );
    expect(code).toBe(0);
    const xml = readFileSync(report, "utf8");
    expect(xml).toContain('<testsuites name="conversational-api-test-mcp" tests="2" failures="0" errors="0"');
    expect(xml).toContain('<testcase name="orders" classname="Shop › happy"');
    expect(out.stdout).toContain("report written to");
  });

  it("fails a step whose body breaks the schema, with the reason in the JUnit failure", async () => {
    const root = workspace();
    mockApi([{ name: "no id" }]);
    const { out, io } = capture();
    const code = await runCli(["--workspace", root, "--flow", "happy", "--reporter", "junit"], io);
    expect(code).toBe(1);
    expect(out.stdout).toContain("<failure message=");
    expect(out.stdout).toContain("must have required property &apos;id&apos;".replace("&apos;", "'").replace("&apos;", "'"));
  });

  it("runs single requests and reports usage errors with exit code 2", async () => {
    const root = workspace();
    mockApi();
    const one = capture();
    expect(await runCli([".mcp/api/shop.yaml", "--workspace", root, "--request", "login", "--reporter", "json"], one.io)).toBe(0);
    expect(JSON.parse(one.out.stdout).suites[0].cases[0]).toMatchObject({ name: "login", ok: true, status: 200 });

    const bad = capture();
    expect(await runCli(["--workspace", root, "--reporter", "tap"], bad.io)).toBe(2);
    expect(await runCli(["--workspace", root, "--flow", "nope"], bad.io)).toBe(2);
    expect(bad.out.stderr).toContain("nothing to run");
  });
});
