import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { parseApiDefinitionYaml } from "../canonical/io.js";
import { omitNullish, safeTool, textResult } from "./toolResult.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { pickFields } from "./pickFields.js";

export const summarizeApiDefinitionInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  definitionRelativePath: z.string(),
  detailLevel: z
    .enum(["names_only", "full"])
    .optional()
    .default("names_only"),
  requestId: z.string().optional(),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "When given (detailLevel names_only only), projects each `endpoints` item to these keys only (id/method/path/description).",
    ),
});

export type SummarizeApiDefinitionRequest = z.infer<
  typeof summarizeApiDefinitionInputSchema
>;

export async function summarizeApiDefinitionHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = summarizeApiDefinitionInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }

  return safeTool(async () => {
    const {
      workspaceRoot: workspaceRootArg,
      definitionRelativePath,
      detailLevel,
      requestId,
      fields,
    } = parsed.data;

    const workspaceRoot = resolveWorkspaceRoot(workspaceRootArg);

    const full = safeResolveUnderWorkspace(
      workspaceRoot,
      definitionRelativePath,
    );
    if (!existsSync(full)) {
      throw new Error(`File not found: ${definitionRelativePath}`);
    }

    const rawText = readFileSync(full, "utf8");

    // full: mantém o mesmo comportamento conceitual do `read_api_definition`.
    if (detailLevel === "full") {
      const def = parseApiDefinitionYaml(rawText);
      return { path: definitionRelativePath, definition: def };
    }

    const raw = parseYaml(rawText, { merge: true }) as Record<string, unknown>;
    const service = (raw.service ?? raw.name ?? null) as string | null;
    const base_url = raw.base_url as string | undefined;
    const variables = (raw.variables as Record<string, unknown> | undefined) ?? {};
    const variableKeys = Object.keys(variables);

    const tags = Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined;
    const flowsRaw = raw.flows as
      | Record<string, { steps?: unknown[]; description?: string }>
      | undefined;
    const flowNames = flowsRaw ? Object.keys(flowsRaw) : undefined;
    const evalNames =
      raw.evals && typeof raw.evals === "object"
        ? Object.keys(raw.evals)
        : undefined;

    const endpointsRaw = (raw.endpoints as Array<Record<string, unknown>> | undefined) ?? [];
    const endpoints = endpointsRaw.map((e) =>
      pickFields(
        { id: e.id, method: e.method, path: e.path, description: e.description },
        fields,
      ),
    );

    const endpoint = requestId
      ? endpointsRaw.find((e) => e.id === requestId)
      : undefined;

    return omitNullish({
      path: definitionRelativePath,
      service,
      base_url,
      variableKeys,
      tags,
      flowNames,
      evalNames,
      endpointCount: endpointsRaw.length,
      endpoints,
      endpoint,
    });
  });
}

