import { readFileSync } from "node:fs";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { writeApiDefinitionFile } from "../canonical/io.js";
import { parseLegacyToCanonical } from "../conversion/ParserFactory.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { safeTool, textResult } from "./toolResult.js";

export const convertLegacyToCanonicalInputSchema = z.object({
  workspaceRoot: z.string(),
  legacyRelativePath: z.string().describe("Path to Postman/OpenAPI/Insomnia file"),
  outputRelativePath: z
    .string()
    .optional()
    .describe("Defaults to .mcp/api/imported.yaml"),
  serviceName: z.string().optional(),
});

export async function convertLegacyToCanonicalHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = convertLegacyToCanonicalInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const full = safeResolveUnderWorkspace(
      parsed.data.workspaceRoot,
      parsed.data.legacyRelativePath,
    );
    const raw = readFileSync(full, "utf8");
    let data: unknown;
    const lower = parsed.data.legacyRelativePath.toLowerCase();
    if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
      data = parseYaml(raw);
    } else {
      data = JSON.parse(raw) as unknown;
    }
    const result = parseLegacyToCanonical(data, {
      serviceName: parsed.data.serviceName,
    });
    const outRel =
      parsed.data.outputRelativePath ?? ".mcp/api/imported.yaml";
    const outAbs = safeResolveUnderWorkspace(
      parsed.data.workspaceRoot,
      outRel,
    );
    writeApiDefinitionFile(outAbs, result.canonical);
    return {
      outputPath: outRel,
      source: result.sourceLabel,
      losses: result.losses,
      endpointCount: result.canonical.endpoints.length,
    };
  });
}
