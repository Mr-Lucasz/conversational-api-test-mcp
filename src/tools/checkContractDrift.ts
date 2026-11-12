import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { schemaFailures } from "../assertion/jsonSchema.js";
import { readApiDefinitionFile } from "../canonical/io.js";
import {
  findOperation,
  HTTP_METHODS,
  responseSchemaPointer,
  type OpenApiDoc,
} from "../contract/openapi.js";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import { runEndpointWithDefinition } from "../http/runEndpoint.js";
import type { LastHttpResponse } from "../session/SessionStore.js";
import { isSafeMethod } from "../vander/plan.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

export const checkContractDriftInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  definitionRelativePath: z.string(),
  openapiRelativePath: z.string().describe("OpenAPI / Swagger file in the workspace."),
  requestIds: z.array(z.string()).optional().describe("Default: all."),
  includeDestructive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Also send POST/PUT/PATCH/DELETE (ask first)."),
});

const MAX_UNCOVERED = 15;

type Row = { requestId: string; operation: string; status: number | ""; result: string; detail: string };

export async function checkContractDriftHandler(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = checkContractDriftInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const { definitionRelativePath, openapiRelativePath, requestIds, includeDestructive } = parsed.data;
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    const def = readApiDefinitionFile(safeResolveUnderWorkspace(workspaceRoot, definitionRelativePath));
    const specFile = safeResolveUnderWorkspace(workspaceRoot, openapiRelativePath);
    const text = readFileSync(specFile, "utf8");
    const doc = (specFile.endsWith(".json") ? JSON.parse(text) : parseYaml(text)) as OpenApiDoc;
    if (!doc || (!doc.openapi && !doc.swagger)) {
      throw new Error(`${openapiRelativePath} is not an OpenAPI / Swagger document`);
    }
    const specRef = relative(workspaceRoot, specFile).replaceAll("\\", "/");
    const envLocal = loadEnvMcpLocalParsed(workspaceRoot);

    const wanted = requestIds ? new Set(requestIds) : null;
    const rows: Row[] = [];
    const covered = new Set<string>();

    for (const ep of def.endpoints) {
      if (wanted && !wanted.has(ep.id)) continue;
      const op = findOperation(doc, ep.method, ep.path);
      const operation = op ? `${ep.method} ${op.template}` : `${ep.method} ${ep.path}`;
      if (!op) {
        rows.push({ requestId: ep.id, operation, status: "", result: "not-in-spec", detail: "no operation in the spec matches this method and path" });
        continue;
      }
      covered.add(`${ep.method.toLowerCase()} ${op.template}`);
      if (!isSafeMethod(ep.method) && !includeDestructive) {
        rows.push({ requestId: ep.id, operation, status: "", result: "skipped", detail: "state-changing; rerun with includeDestructive" });
        continue;
      }
      let response: LastHttpResponse | undefined;
      const result = await runEndpointWithDefinition({
        workspaceRoot,
        def,
        envLocal,
        requestId: ep.id,
        chain: [],
        allow401Retry: true,
        outputOptions: { responseDetail: "minimal" },
        runOptions: { ephemeral: true, onResponse: (r) => void (response = r) },
      });
      if (!response) {
        rows.push({ requestId: ep.id, operation, status: "", result: "error", detail: result.ok ? "no response" : result.message });
        continue;
      }
      const where = responseSchemaPointer(doc, op.template, ep.method, response.status);
      if (!where.documented) {
        rows.push({ requestId: ep.id, operation, status: response.status, result: "drift", detail: `status ${response.status} is not documented for this operation` });
        continue;
      }
      if (!where.pointer) {
        rows.push({ requestId: ep.id, operation, status: response.status, result: "ok", detail: `documented as ${where.code}, no body schema` });
        continue;
      }
      let data: unknown;
      try {
        data = JSON.parse(response.bodyText);
      } catch {
        rows.push({ requestId: ep.id, operation, status: response.status, result: "drift", detail: "spec documents a JSON body; response is not JSON" });
        continue;
      }
      const failures = schemaFailures(data, `${specRef}#${where.pointer}`, workspaceRoot).map((f) =>
        f.replace(/^schema: /, ""),
      );
      rows.push({
        requestId: ep.id,
        operation,
        status: response.status,
        result: failures.length ? "drift" : "ok",
        detail: failures.length ? failures.join("; ") : `matches ${where.code}`,
      });
    }

    const uncovered: string[] = [];
    for (const [template, item] of Object.entries(doc.paths ?? {})) {
      for (const m of HTTP_METHODS) {
        if (item?.[m] && !covered.has(`${m} ${template}`)) uncovered.push(`${m.toUpperCase()} ${template}`);
      }
    }
    const count = (r: string) => rows.filter((x) => x.result === r).length;
    return {
      summary: { ok: count("ok"), drift: count("drift"), notInSpec: count("not-in-spec"), skipped: count("skipped"), error: count("error") },
      results: rows,
      ...(!wanted && uncovered.length
        ? {
            notCoveredBySpecOperations: uncovered.slice(0, MAX_UNCOVERED),
            ...(uncovered.length > MAX_UNCOVERED ? { moreNotCovered: uncovered.length - MAX_UNCOVERED } : {}),
          }
        : {}),
    };
  });
}
