import { z } from "zod";

/** HTTP methods supported for execution */
export const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** Map: session variable name → JSONPath. Also accepts a list form from YAML: `{ jsonPath, exportTo }[]`. */
export const endpointCaptureSchema = z.preprocess((val) => {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (Array.isArray(val)) {
    const out: Record<string, string> = {};
    for (const row of val) {
      if (
        row &&
        typeof row === "object" &&
        "jsonPath" in row &&
        "exportTo" in row
      ) {
        const r = row as { jsonPath: unknown; exportTo: unknown };
        out[String(r.exportTo)] = String(r.jsonPath);
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  return val;
}, z.record(z.string(), z.string()).optional());

const stringOrList = z.union([z.string(), z.array(z.string()).min(1)]);
const scalar = z.union([z.string(), z.number(), z.boolean()]);

/**
 * One check on a value of the response. `path` is a JSONPath; without it the check
 * reads the whole body as text. Every operator given must hold.
 */
export const valueCheckSchema = z
  .object({
    path: z.string().optional(),
    /** Text contains this (a list: all of them). */
    contains: stringOrList.optional(),
    /** Text contains at least one of these. */
    containsAny: z.array(z.string()).min(1).optional(),
    /** Text contains none of these. */
    notContains: stringOrList.optional(),
    /** Regular expression the text must match. */
    matches: z.string().optional(),
    /** `contains*` and `matches` ignore case. */
    ignoreCase: z.boolean().optional(),
    equals: z.unknown().optional(),
    /** Numeric bounds. */
    min: z.number().optional(),
    max: z.number().optional(),
    /** Length of a string or of a list (`minLength: 1` on citations = "cites something"). */
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    /** The list at `path` holds these values — with `minRatio`, at least that share of them (recall). */
    includesAll: z.array(scalar).min(1).optional(),
    includesAny: z.array(scalar).min(1).optional(),
    minRatio: z.number().min(0).max(1).optional(),
    /** Every value at `path` also appears at this other JSONPath (citations ⊆ retrieved documents). */
    subsetOf: z.string().optional(),
  })
  .strict();

export type ValueCheck = z.infer<typeof valueCheckSchema>;

export const assertSpecSchema = z
  .object({
    status: z.number().int().optional(),
    jsonPathExists: z.string().optional(),
    maxDurationMs: z.number().int().positive().optional(),
    checks: z.array(valueCheckSchema).optional(),
  })
  .strict();

export type AssertSpec = z.infer<typeof assertSpecSchema>;

/** One-line summary of the assert shape, for tool schemas that publish it shallowly. */
export const ASSERT_HINT =
  "{status, jsonPathExists, maxDurationMs, checks: [{path (JSONPath; omit = whole body), contains | containsAny | notContains | matches | equals | min | max | minLength | maxLength | includesAll | includesAny | subsetOf (another JSONPath), ignoreCase, minRatio}]}";

export const endpointAssertSchema = assertSpecSchema.optional();

export const endpointSchema = z
  .object({
    id: z.string().min(1),
    method: httpMethodSchema,
    path: z.string().min(1),
    description: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    params: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    /** application/x-www-form-urlencoded body — mutually exclusive with `body`. Serialized via URLSearchParams. */
    form: z.record(z.string(), z.string()).optional(),
    auth: z.string().optional(),
    /**
     * HTTP Digest (RFC 2617): first request without Authorization, then on 401
     * parses `WWW-Authenticate: Digest ...` and retries with `Authorization: Digest ...`.
     * Username/password support `{{VAR}}` interpolation (e.g. from `.env.mcp.local`).
     * Mutually exclusive with `auth` on the same endpoint.
     */
    digest_auth: z
      .object({
        username: z.string().min(1),
        password: z.string().min(1),
      })
      .optional(),
    /** Run this endpoint id first when session lacks vars from that endpoint's `capture`, or on 401 (see `auth_retry_on_401`). */
    auth_dependency: z.string().min(1).optional(),
    /** When not false, clear auth `capture` vars and re-run `auth_dependency` after a 401, then retry the request once. Omitted = same as true. */
    auth_retry_on_401: z.boolean().optional(),
    capture: endpointCaptureSchema,
    assert: endpointAssertSchema,
    /**
     * Streaming (`text/event-stream`) responses are folded into one JSON body:
     * `{ text, eventCount, events }`. `textPath` is the JSONPath of the text delta
     * inside each event, when the usual ones (OpenAI, Anthropic, …) do not apply.
     */
    sse: z.object({ textPath: z.string().optional() }).optional(),
  })
  .refine(
    (e) => !(e.body !== undefined && e.form !== undefined),
    { message: "endpoint cannot use both body and form" },
  )
  .refine(
    (e) => !(e.digest_auth !== undefined && e.auth !== undefined),
    { message: "endpoint cannot use both auth and digest_auth" },
  );

/** One step of a flow: which endpoint to run and how to treat its outcome. */
export const flowStepSchema = z.object({
  requestId: z.string(),
  optional: z.boolean().optional().default(false),
  retry: z
    .object({
      max: z.number().int().positive(),
      delayMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  poll: z
    .object({
      untilJsonPath: z.string(),
      maxAttempts: z.number().int().positive(),
      delayMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  acceptStatus: z.array(z.number().int()).optional(),
  /** Extra check against this step's response, evaluated inline — avoids a separate assert_response round trip after the flow. */
  assert: endpointAssertSchema,
  /** Return this step's response body, projected by this JSONPath (`$` = whole body) — saves a follow-up call just to read it. */
  jsonPathSelect: z.string().optional(),
});

export type FlowStep = z.infer<typeof flowStepSchema>;

/** One input of an eval: the variables that fill the request and what the answer must satisfy. */
export const evalCaseSchema = z
  .object({
    name: z.string().min(1),
    variables: z.record(z.string(), scalar).optional(),
    expect: endpointAssertSchema,
    /** Expected answer, shown to the judge (never compared by code). */
    reference: z.string().optional(),
  })
  .strict();

export type EvalCase = z.infer<typeof evalCaseSchema>;

/** What to hand the agent so it can grade what code cannot (faithfulness, relevance…). */
export const evalJudgeSchema = z
  .object({
    /** JSONPath of the answer text in the response. */
    answerPath: z.string(),
    /** JSONPath of the retrieved passages. */
    contextPath: z.string().optional(),
    /** Variable that holds the question (default: every case variable is shown). */
    questionVariable: z.string().optional(),
    /** `faithfulness`, `relevance`, `context_relevance`, `correctness`, or a rubric in your own words. */
    criteria: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export type EvalJudge = z.infer<typeof evalJudgeSchema>;

const evalSettings = {
  /** Times each case is sent; an answer that varies needs more than one sample. */
  repeat: z.number().int().positive().max(20).optional(),
  /** Share of a case's runs that must pass (default 1 = all of them). */
  passRate: z.number().min(0).max(1).optional(),
  judge: evalJudgeSchema.optional(),
};

export const evalDefinitionSchema = z
  .object({
    description: z.string().optional(),
    requestId: z.string().min(1),
    ...evalSettings,
    /** Applied to every case, before the case's own `expect`. */
    expect: endpointAssertSchema,
    cases: z.array(evalCaseSchema).min(1),
  })
  .strict();

export type EvalDefinition = z.infer<typeof evalDefinitionSchema>;
export const apiDefinitionYamlSchema = z.object({
  version: z.string().default("1"),
  service: z.string().optional(),
  name: z.string().optional(),
  base_url: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  /**
   * Named, reusable chains. Run one with `execute_api_flow` + `flowName`.
   * Each step is an endpoint id or a full step object (retry / poll / assert).
   */
  flows: z
    .record(
      z.object({
        description: z.string().optional(),
        steps: z.array(z.union([z.string(), flowStepSchema])).optional(),
      }),
    )
    .optional(),
  /**
   * Named evaluations: one endpoint run over many cases, each possibly several
   * times. Run one with `run_eval` + `evalName`. Meant for answers that vary
   * (LLM / RAG endpoints), but works for any endpoint.
   */
  evals: z.record(evalDefinitionSchema).optional(),
  endpoints: z.array(endpointSchema).default([]),
});

export type ApiDefinitionYaml = z.infer<typeof apiDefinitionYamlSchema>;
export type EndpointDefinition = z.infer<typeof endpointSchema>;

/** `path: message` for each problem — a ZodError printed whole is a wall of JSON. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}
