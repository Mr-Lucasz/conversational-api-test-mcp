import { dirname, relative } from "node:path";
import type { ApiDefinitionYaml, EndpointDefinition, FlowStep } from "../canonical/schema.js";
import { isSensitiveName } from "../http/redact.js";

/**
 * Exports of a canonical definition to the formats other tools speak: OpenAPI 3.1 (what the
 * requests look like), Arazzo 1.0 (the flows, referencing that OpenAPI) and Pact v3 (draft
 * consumer contracts). All three are drafts to review: they describe what the YAML says
 * and what was recorded, not everything the API can do.
 */

type Json = Record<string, unknown>;
const PLACEHOLDER = /\{\{([^}]+)\}\}/g;

function successCode(ep: EndpointDefinition): number {
  return ep.assert?.status ?? (ep.method === "POST" ? 201 : 200);
}

export function openApiPath(path: string): string {
  return (path.split("?")[0] ?? path).replace(PLACEHOLDER, "{$1}");
}

/** A JSON Schema guessed from an example value. */
export function inferSchema(value: unknown): Json {
  if (Array.isArray(value)) {
    return value.length ? { type: "array", items: inferSchema(value[0]) } : { type: "array" };
  }
  if (value === null) return {};
  if (typeof value === "object") {
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inferSchema(v)])),
    };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

/**
 * `assert.schema` / `body_schema` as seen from the exported file: inline schemas are copied,
 * `file#/pointer` becomes a `$ref` relative to where the export is written.
 */
function schemaRef(
  schema: string | Json,
  ctx: { workspaceRoot: string; outFile: string },
): Json {
  if (typeof schema !== "string") return schema;
  const hash = schema.indexOf("#");
  const file = hash === -1 ? schema : schema.slice(0, hash);
  const pointer = hash === -1 ? "" : schema.slice(hash);
  const rel = relative(dirname(ctx.outFile), `${ctx.workspaceRoot}/${file}`).replaceAll("\\", "/");
  return { $ref: `${rel}${pointer}` };
}

function hasPlaceholder(v: unknown): boolean {
  return JSON.stringify(v ?? "").includes("{{");
}

export function buildOpenApi(
  def: ApiDefinitionYaml,
  ctx: { workspaceRoot: string; outFile: string },
): Json {
  const paths: Record<string, Json> = {};
  const schemes: Json = {};
  for (const ep of def.endpoints) {
    const path = openApiPath(ep.path);
    const parameters: Json[] = [...ep.path.matchAll(PLACEHOLDER)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    for (const [name, value] of Object.entries(ep.params ?? {})) {
      parameters.push({
        name,
        in: "query",
        schema: { type: "string" },
        ...(hasPlaceholder(value) || isSensitiveName(name) ? {} : { example: value }),
      });
    }
    for (const [name, value] of Object.entries(ep.headers ?? {})) {
      if (/^(authorization|content-type|accept|cookie)$/i.test(name)) continue;
      parameters.push({
        name,
        in: "header",
        schema: { type: "string" },
        ...(hasPlaceholder(value) || isSensitiveName(name) ? {} : { example: value }),
      });
    }
    const op: Json = {
      operationId: ep.id,
      ...(ep.description ? { summary: ep.description } : {}),
      ...(parameters.length ? { parameters } : {}),
    };
    if (ep.form) {
      op.requestBody = {
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              properties: Object.fromEntries(Object.keys(ep.form).map((k) => [k, { type: "string" }])),
            },
          },
        },
      };
    } else if (ep.body !== undefined) {
      op.requestBody = {
        content: {
          "application/json": {
            schema: ep.body_schema ? schemaRef(ep.body_schema as string | Json, ctx) : inferSchema(ep.body),
            example: ep.body,
          },
        },
      };
    }
    const code = String(successCode(ep));
    op.responses = {
      [code]: {
        description: "Expected response",
        ...(ep.assert?.schema !== undefined
          ? { content: { "application/json": { schema: schemaRef(ep.assert.schema as string | Json, ctx) } } }
          : {}),
      },
    };
    const auth = ep.auth ?? "";
    if (auth) {
      const name = /^bearer/i.test(auth) ? "bearerAuth" : /^basic/i.test(auth) ? "basicAuth" : "authorizationHeader";
      schemes[name] =
        name === "bearerAuth"
          ? { type: "http", scheme: "bearer" }
          : name === "basicAuth"
            ? { type: "http", scheme: "basic" }
            : { type: "apiKey", in: "header", name: "Authorization" };
      op.security = [{ [name]: [] }];
    } else if (ep.digest_auth) {
      schemes.digestAuth = { type: "http", scheme: "digest" };
      op.security = [{ digestAuth: [] }];
    }
    paths[path] = { ...(paths[path] ?? {}), [ep.method.toLowerCase()]: op };
  }

  const base = def.base_url ?? "{{base_url}}";
  const vars = [...base.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
  const server: Json = { url: base.replace(PLACEHOLDER, "{$1}") };
  if (vars.length) {
    server.variables = Object.fromEntries(
      vars.map((v) => [v, { default: def.variables?.[v] || "https://api.example.com" }]),
    );
  }
  return {
    openapi: "3.1.0",
    info: { title: def.service ?? def.name ?? "API", version: def.version ?? "1" },
    servers: [server],
    paths,
    ...(Object.keys(schemes).length ? { components: { securitySchemes: schemes } } : {}),
  };
}

/** `$.a.b[0]` → `/a/b/0`; undefined for filters, wildcards and other non-pointer paths. */
export function jsonPathToPointer(path: string): string | undefined {
  if (!path.startsWith("$")) return undefined;
  const parts: string[] = [];
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/gy;
  re.lastIndex = 1;
  let m: RegExpExecArray | null;
  let consumed = 1;
  while ((m = re.exec(path))) {
    parts.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").replace(/~/g, "~0").replace(/\//g, "~1"));
    consumed = re.lastIndex;
  }
  return consumed === path.length ? `/${parts.join("/")}` : undefined;
}

export function buildArazzo(
  def: ApiDefinitionYaml,
  openapiRelative: string,
): { doc: Json; notes: string[] } {
  const notes: string[] = [];
  const byId = new Map(def.endpoints.map((e) => [e.id, e]));
  const workflows: Json[] = [];
  for (const [name, flow] of Object.entries(def.flows ?? {})) {
    const producedBy = new Map<string, string>();
    const inputs = new Set<string>();
    const used = new Map<string, number>();
    const steps: Json[] = [];
    const resolveVar = (v: string) => {
      const from = producedBy.get(v);
      if (from) return `$steps.${from}.outputs.${v}`;
      inputs.add(v);
      return `$inputs.${v}`;
    };
    const runtime = (value: unknown): unknown => {
      if (typeof value === "string") {
        const whole = /^\{\{([^}]+)\}\}$/.exec(value);
        if (whole) return resolveVar(whole[1] as string);
        return value.replace(PLACEHOLDER, (_m, v: string) => `{${resolveVar(v)}}`);
      }
      if (Array.isArray(value)) return value.map(runtime);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, runtime(v)]));
      }
      return value;
    };
    for (const raw of flow.steps ?? []) {
      const step: FlowStep = typeof raw === "string" ? { requestId: raw, optional: false } : raw;
      const ep = byId.get(step.requestId);
      if (!ep) {
        notes.push(`flow ${name}: unknown request ${step.requestId}, left out`);
        continue;
      }
      const n = (used.get(ep.id) ?? 0) + 1;
      used.set(ep.id, n);
      const stepId = n === 1 ? ep.id : `${ep.id}_${n}`;
      const parameters = [...ep.path.matchAll(PLACEHOLDER)].map((m) => ({
        name: m[1],
        in: "path",
        value: resolveVar(m[1] as string),
      }));
      for (const [k, v] of Object.entries(ep.params ?? {})) {
        if (hasPlaceholder(v)) parameters.push({ name: k, in: "query", value: runtime(v) as string });
      }
      const accepted = step.acceptStatus?.length ? step.acceptStatus : [step.assert?.status ?? successCode(ep)];
      const out: Json = {
        stepId,
        operationId: ep.id,
        ...(parameters.length ? { parameters } : {}),
        ...(ep.body !== undefined && hasPlaceholder(ep.body)
          ? { requestBody: { contentType: "application/json", payload: runtime(ep.body) } }
          : {}),
        successCriteria: [{ condition: accepted.map((c) => `$statusCode == ${c}`).join(" || ") }],
      };
      const outputs: Json = {};
      for (const [v, path] of Object.entries(ep.capture ?? {})) {
        const pointer = jsonPathToPointer(path);
        if (pointer) {
          outputs[v] = `$response.body#${pointer}`;
          producedBy.set(v, stepId);
        } else {
          notes.push(`flow ${name}: capture ${v} (${path}) is not a plain path; add its output by hand`);
        }
      }
      if (Object.keys(outputs).length) out.outputs = outputs;
      if (step.optional) out.onFailure = [{ name: "continue", type: "goto", stepId: "$next" }];
      steps.push(out);
    }
    workflows.push({
      workflowId: name,
      ...(flow.description ? { summary: flow.description } : {}),
      ...(inputs.size
        ? {
            inputs: {
              type: "object",
              properties: Object.fromEntries([...inputs].map((v) => [v, { type: "string" }])),
            },
          }
        : {}),
      steps,
    });
  }
  if (!workflows.length) notes.push("the definition declares no flows: the Arazzo document has no workflows");
  return {
    doc: {
      arazzo: "1.0.1",
      info: { title: `${def.service ?? def.name ?? "API"} workflows`, version: def.version ?? "1" },
      sourceDescriptions: [{ name: "api", url: openapiRelative, type: "openapi" }],
      workflows,
    },
    notes,
  };
}

export function buildPact(
  def: ApiDefinitionYaml,
  opts: { consumer: string; responseBody: (ep: EndpointDefinition) => { body?: unknown; source: string } },
): { doc: Json; notes: string[] } {
  const notes: string[] = [];
  const example = (value: string) =>
    value.replace(PLACEHOLDER, (_m, v: string) => def.variables?.[v] || "1");
  const interactions = def.endpoints.map((ep) => {
    const query = Object.fromEntries(
      Object.entries(ep.params ?? {}).map(([k, v]) => [k, [example(v)]]),
    );
    const { body, source } = opts.responseBody(ep);
    if (source === "none") notes.push(`${ep.id}: no recorded or documented body; the response body is left out`);
    return {
      description: ep.description ?? `${ep.method} ${ep.path}`,
      request: {
        method: ep.method,
        path: example(ep.path.split("?")[0] ?? ep.path),
        ...(Object.keys(query).length ? { query } : {}),
        ...(ep.body !== undefined
          ? { headers: { "Content-Type": "application/json" }, body: ep.body }
          : {}),
      },
      response: {
        status: successCode(ep),
        ...(body !== undefined
          ? {
              headers: { "Content-Type": "application/json" },
              body,
              // Draft contract: assert the shape the consumer relies on, not this exact data.
              matchingRules: { body: { $: { matchers: [{ match: "type" }] } } },
            }
          : {}),
      },
    };
  });
  return {
    doc: {
      consumer: { name: opts.consumer },
      provider: { name: def.service ?? def.name ?? "provider" },
      interactions,
      metadata: { pactSpecification: { version: "3.0.0" } },
    },
    notes,
  };
}
