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

export const endpointAssertSchema = z
  .object({
    status: z.number().int().optional(),
    jsonPathExists: z.string().optional(),
  })
  .optional();

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
  /** Extra check (status/jsonPathExists) against this step's response, evaluated inline — avoids a separate assert_response round trip after the flow. */
  assert: z
    .object({
      status: z.number().int().optional(),
      jsonPathExists: z.string().optional(),
    })
    .optional(),
});

export type FlowStep = z.infer<typeof flowStepSchema>;

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
  endpoints: z.array(endpointSchema).default([]),
});

export type ApiDefinitionYaml = z.infer<typeof apiDefinitionYamlSchema>;
export type EndpointDefinition = z.infer<typeof endpointSchema>;
