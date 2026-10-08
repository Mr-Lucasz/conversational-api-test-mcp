import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { collectAssertFailures } from "../src/assertion/assertResponse.js";
import { parseApiDefinitionYaml } from "../src/canonical/io.js";
import { redactJsonValue } from "../src/http/redact.js";
import { foldEventStream } from "../src/http/sse.js";
import {
  clearSessionForTests,
  getLastResponse,
  getSessionVariable,
} from "../src/session/SessionStore.js";
import { assertResponseHandler } from "../src/tools/assertResponseTool.js";
import { executeApiRequestHandler } from "../src/tools/executeApiRequest.js";
import { runEvalHandler } from "../src/tools/runEval.js";

const DEF = ".mcp/api/rag.yaml";
const YAML = [
  "version: '1'",
  "base_url: http://rag.test",
  "endpoints:",
  "  - id: login",
  "    method: POST",
  "    path: /login",
  "    capture:",
  "      access_token: $.access_token",
  "  - id: ask",
  "    method: POST",
  "    path: /ask",
  "    auth: Bearer {{access_token}}",
  "    auth_dependency: login",
  "    body:",
  "      question: '{{question}}'",
  "    capture:",
  "      last_answer: $.answer",
  "  - id: ask_stream",
  "    method: POST",
  "    path: /stream",
  "    body:",
  "      question: '{{question}}'",
  "evals:",
  "  smoke:",
  "    requestId: ask",
  "    repeat: 3",
  "    passRate: 0.66",
  "    expect:",
  "      status: 200",
  "      checks:",
  "        - path: $.citations",
  "          subsetOf: $.sources[*].id",
  "    judge:",
  "      answerPath: $.answer",
  "      contextPath: $.sources[*].text",
  "      questionVariable: question",
  "    cases:",
  "      - name: capital",
  "        variables: { question: What is the capital of France? }",
  "        reference: Paris",
  "        expect:",
  "          checks:",
  "            - path: $.answer",
  "              contains: paris",
  "              ignoreCase: true",
  "            - path: $.sources[*].id",
  "              includesAll: [doc-fr, doc-eu]",
  "              minRatio: 0.5",
  "      - name: out_of_scope",
  "        variables: { question: Who wins the next election? }",
  "        expect:",
  "          checks:",
  "            - path: $.answer",
  "              matches: \"(don't|do not) know\"",
  "            - path: $.citations",
  "              maxLength: 0",
].join("\n");

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-eval-"));
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

/** A RAG whose wording changes on every call, and that gets one "capital" answer in three wrong. */
function fakeRag(calls: string[]): typeof fetch {
  let capitalCalls = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input.toString()).pathname;
    calls.push(path);
    if (path === "/login") {
      return json({ access_token: "good" });
    }
    if ((init?.headers as Record<string, string>)?.Authorization !== "Bearer good") {
      return json({ error: "unauthorized" }, 401);
    }
    const { question } = JSON.parse(String(init?.body)) as { question: string };
    if (question.includes("France")) {
      const n = capitalCalls++;
      return json({
        answer: n === 1 ? "It is Lyon." : `Paris is the capital (take ${n}).`,
        citations: ["doc-fr"],
        sources: [
          { id: "doc-fr", text: "Paris is the capital of France." },
          { id: "doc-x", text: "Unrelated passage." },
        ],
        usage: { total_tokens: 42 },
      });
    }
    return json({ answer: "I don't know.", citations: [], sources: [] });
  }) as typeof fetch;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

type Report = {
  ok: boolean;
  summary: Record<string, number>;
  cases: Array<Record<string, unknown>>;
  failures?: Array<{ case: string; runs: string; message: string }>;
  judge?: {
    note: string;
    criteria: string[];
    samples: Array<Record<string, unknown>>;
  };
};

async function evalReport(args: Record<string, unknown>): Promise<Report> {
  const out = await runEvalHandler({ definitionRelativePath: DEF, ...args });
  expect(out.isError, out.content[0].text).toBeFalsy();
  return decode(out.content[0].text) as Report;
}

describe("value checks", () => {
  const response = (body: unknown, durationMs = 100) => ({
    status: 200,
    headers: {},
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
    durationMs,
  });
  const body = {
    answer: "Paris is the capital.",
    score: 0.9,
    citations: ["a", "b"],
    sources: [{ id: "a" }, { id: "b" }, { id: "c" }],
  };

  it("pass when every operator holds", () => {
    expect(
      collectAssertFailures(response(body), {
        maxDurationMs: 500,
        checks: [
          { path: "$.answer", contains: ["Paris", "capital"], notContains: "Lyon" },
          { path: "$.answer", containsAny: ["Rome", "PARIS"], ignoreCase: true },
          { path: "$.answer", matches: "^Paris\\b", minLength: 5, maxLength: 200 },
          { path: "$.score", min: 0.5, max: 1 },
          { path: "$.score", equals: 0.9 },
          { path: "$.citations", minLength: 1, subsetOf: "$.sources[*].id" },
          { path: "$.sources[*].id", includesAll: ["a", "c"], includesAny: ["z", "b"] },
          { contains: "capital" },
        ],
      }),
    ).toEqual([]);
  });

  it("report every failing operator with what was found", () => {
    const failures = collectAssertFailures(response(body, 900), {
      status: 201,
      maxDurationMs: 500,
      checks: [
        { path: "$.answer", contains: "Lyon" },
        { path: "$.answer", notContains: "Paris" },
        { path: "$.score", min: 0.95 },
        { path: "$.citations", maxLength: 1 },
        { path: "$.sources[*].id", includesAll: ["a", "x", "y", "z"], minRatio: 0.5 },
        { path: "$.citations", subsetOf: "$.missing[*].id" },
        { path: "$.nope", contains: "x" },
      ],
    });
    expect(failures).toEqual([
      "Expected status 201, got 200",
      "Took 900ms, over the 500ms budget",
      '$.answer: does not contain ["Lyon"]; got "Paris is the capital."',
      '$.answer: contains ["Paris"]',
      "$.score: 0.9 is below 0.95",
      "$.citations: length 2 is above 1",
      '$.sources[*].id: has 1 of 4 expected values (needs 0.5); missing ["x","y","z"]',
      '$.citations: ["a","b"] not found at $.missing[*].id',
      "$.nope: no match",
    ]);
  });

  it("a single match of a wildcard is still a list", () => {
    const one = { sources: [{ id: 7 }], citations: [7] };
    expect(
      collectAssertFailures(response(one), {
        checks: [
          { path: "$.sources[*].id", includesAll: ["7"], minLength: 1, maxLength: 1 },
          { path: "$.citations", subsetOf: "$.sources[*].id" },
        ],
      }),
    ).toEqual([]);
  });

  it("a text body can be checked without a path, and a path needs JSON", () => {
    expect(
      collectAssertFailures(response("<h1>Hello</h1>"), {
        checks: [{ contains: "hello", ignoreCase: true }, { path: "$.a", contains: "x" }],
      }),
    ).toEqual(["$.a: response body is not JSON"]);
  });

  it("an unknown operator in the YAML is an error, not a silent pass", () => {
    expect(() =>
      parseApiDefinitionYaml(
        [
          "endpoints:",
          "  - id: a",
          "    method: GET",
          "    path: /a",
          "    assert:",
          "      checks:",
          "        - path: $.answer",
          "          contain: Paris",
        ].join("\n"),
      ),
    ).toThrow();
  });

  it("assert_response applies them to the last response", async () => {
    const ws = workspace();
    globalThis.fetch = fakeRag([]);
    await executeApiRequestHandler({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      requestId: "ask",
    });
    const ok = await assertResponseHandler({
      workspaceRoot: ws,
      maxDurationMs: 5000,
      checks: [{ path: "$.answer", contains: "know" }],
    });
    const bad = await assertResponseHandler({
      workspaceRoot: ws,
      checks: [{ path: "$.answer", contains: "Paris" }, { path: "$.citations", minLength: 1 }],
    });
    const typo = await assertResponseHandler({
      workspaceRoot: ws,
      checks: [{ path: "$.answer", contain: "Paris" }],
    });
    clearSessionForTests(ws);

    expect(ok.isError).toBeFalsy();
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("does not contain");
    expect(bad.content[0].text).toContain("length 0 is below 1");
    expect(typo.isError).toBe(true);
    expect(typo.content[0].text).toContain("invalid assert");
  });
});

describe("run_eval", () => {
  it("passes a case on its pass rate, not on a single run", async () => {
    const ws = workspace();
    const calls: string[] = [];
    globalThis.fetch = fakeRag(calls);

    const report = await evalReport({ workspaceRoot: ws, evalName: "smoke" });
    clearSessionForTests(ws);

    // 2 of 3 "capital" runs are right: enough for passRate 0.66.
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      cases: 2,
      passed: 2,
      failed: 0,
      requests: 6,
      requiredPassRate: 0.66,
    });
    expect(report.cases).toEqual([
      expect.objectContaining({ name: "capital", verdict: "pass", passed: "2/3", distinctAnswers: 3 }),
      expect.objectContaining({ name: "out_of_scope", verdict: "pass", passed: "3/3", distinctAnswers: 1 }),
    ]);
    // The wrong run is still reported, once, with how often it happened.
    expect(report.failures).toEqual([
      {
        case: "capital",
        runs: "1/3",
        message: '$.answer: does not contain ["paris"]; got "It is Lyon."',
      },
    ]);
    // One login for the whole eval: the first request goes alone.
    expect(calls.filter((c) => c === "/login")).toHaveLength(1);
    expect(calls.filter((c) => c === "/ask")).toHaveLength(6);
  });

  it("fails the case when the bar is every run, and leaves the session alone", async () => {
    const ws = workspace();
    globalThis.fetch = fakeRag([]);

    const report = await evalReport({
      workspaceRoot: ws,
      evalName: "smoke",
      passRate: 1,
      caseNames: ["capital"],
    });

    expect(report.ok).toBe(false);
    expect(report.cases).toEqual([
      expect.objectContaining({ name: "capital", verdict: "fail", passed: "2/3" }),
    ]);

    // Answers that differ in wording but fail the same check are one failure row.
    const never = await evalReport({
      workspaceRoot: ws,
      evalName: "smoke",
      caseNames: ["capital"],
      expect: { checks: [{ path: "$.answer", contains: "Berlin" }] },
    });
    expect(never.failures?.filter((f) => f.message.includes("Berlin"))).toEqual([
      expect.objectContaining({ case: "capital", runs: "3/3" }),
    ]);
    // Eval runs neither capture nor become "the last response"; only the login did.
    expect(getSessionVariable(ws, "last_answer")).toBeUndefined();
    expect(getLastResponse(ws)?.bodyText).toContain("access_token");
    clearSessionForTests(ws);
  });

  it("hands the agent a capped, redacted sample per case to judge", async () => {
    const ws = workspace();
    globalThis.fetch = fakeRag([]);
    const { judge } = await evalReport({ workspaceRoot: ws, evalName: "smoke", repeat: 1 });
    clearSessionForTests(ws);

    expect(judge?.note).toContain("Not verified by code");
    expect(judge?.criteria.map((c) => c.split(":")[0])).toEqual([
      "faithfulness",
      "relevance",
      "correctness",
    ]);
    expect(judge?.samples[0]).toEqual({
      case: "capital",
      question: "What is the capital of France?",
      answer: "Paris is the capital (take 0).",
      context: ["Paris is the capital of France.", "Unrelated passage."],
      reference: "Paris",
    });
    expect(judge?.samples[1]).toMatchObject({ case: "out_of_scope", context: [] });
  });

  it("runs inline cases, and an error status fails when no status was asked for", async () => {
    const ws = workspace();
    globalThis.fetch = vi.fn(async () => json({ error: "boom" }, 500)) as typeof fetch;
    const report = await evalReport({
      workspaceRoot: ws,
      requestId: "ask_stream",
      cases: [{ name: "any", variables: { question: "hi" } }],
    });
    clearSessionForTests(ws);

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([{ case: "any", runs: "1/1", message: "status 500" }]);
    expect(report).not.toHaveProperty("judge");
  });

  it("refuses to start over the request budget, and explains bad input", async () => {
    const ws = workspace();
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("no network"))) as typeof fetch;

    const over = await runEvalHandler({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      evalName: "smoke",
      maxRequests: 5,
    });
    const unknown = await runEvalHandler({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      evalName: "nope",
    });
    const typo = await runEvalHandler({
      workspaceRoot: ws,
      definitionRelativePath: DEF,
      requestId: "ask",
      cases: [{ name: "a", expect: { checks: [{ path: "$.a", contain: "x" }] } }],
    });

    expect(over.isError).toBe(true);
    expect(over.content[0].text).toContain("6 requests (2 cases × 3)");
    expect(unknown.content[0].text).toContain("available: smoke");
    expect(typo.content[0].text).toContain("invalid eval");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("streaming responses", () => {
  const openAiStream = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"content":"Par"}}]}',
    'data: {"choices":[{"delta":{"content":"is"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":12}}',
    "data: [DONE]",
    "",
  ].join("\n\n");

  it("folds text deltas into one answer and keeps the other events", () => {
    expect(JSON.parse(foldEventStream(openAiStream))).toEqual({
      text: "Paris",
      eventCount: 4,
      events: [
        { choices: [{ delta: { role: "assistant" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 12 } },
      ],
    });
  });

  it("honours a custom textPath, named events and bare-token streams", () => {
    const custom = 'event: chunk\ndata: {"piece":"He"}\n\nevent: chunk\ndata: {"piece":"y"}\n\nevent: sources\ndata: {"ids":[1]}\n\n';
    expect(JSON.parse(foldEventStream(custom, "$.piece"))).toEqual({
      text: "Hey",
      eventCount: 3,
      events: [{ event: "sources", data: { ids: [1] } }],
    });
    expect(JSON.parse(foldEventStream("data: Hel\n\ndata: lo\n\n")).text).toBe("Hello");
  });

  it("a streamed endpoint is asserted like any other", async () => {
    const ws = workspace();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(openAiStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        }),
    ) as typeof fetch;

    const out = decode(
      (
        await executeApiRequestHandler({
          workspaceRoot: ws,
          definitionRelativePath: DEF,
          requestId: "ask_stream",
          jsonPathSelect: "$.text",
        })
      ).content[0].text,
    ) as Record<string, unknown>;
    const report = await evalReport({
      workspaceRoot: ws,
      requestId: "ask_stream",
      cases: [
        {
          name: "capital",
          variables: { question: "capital of France?" },
          expect: { checks: [{ path: "$.text", equals: "Paris" }] },
        },
      ],
    });
    clearSessionForTests(ws);

    expect(out.bodyJson).toBe("Paris");
    expect(report.ok).toBe(true);
  });
});

describe("redaction of LLM usage figures", () => {
  it("keeps token counts readable and still hides token values", () => {
    const { value } = redactJsonValue({
      usage: {
        total_tokens: 42,
        prompt_tokens_details: { cached_tokens: 3 },
      },
      access_token: "abc",
      tokens: { access: "abc", ttl: 60 },
      max_tokens: "abc",
    });
    expect(value).toEqual({
      usage: { total_tokens: 42, prompt_tokens_details: { cached_tokens: 3 } },
      access_token: "[REDACTED]",
      tokens: { access: "[REDACTED]", ttl: "[REDACTED]" },
      max_tokens: "[REDACTED]",
    });
  });
});
