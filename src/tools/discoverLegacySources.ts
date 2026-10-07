import { z } from "zod";
import { discoverLegacyApiSources } from "../workspace/discovery.js";
import { safeTool, textResult } from "./toolResult.js";

export const discoverLegacySourcesInputSchema = z.object({
  workspaceRoot: z.string(),
  maxFiles: z.number().int().positive().optional(),
  maxDepth: z.number().int().positive().optional(),
});

export async function discoverLegacySourcesHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = discoverLegacySourcesInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const hits = await discoverLegacyApiSources({
      workspaceRoot: parsed.data.workspaceRoot,
      maxFiles: parsed.data.maxFiles,
      maxDepth: parsed.data.maxDepth,
    });
    return { count: hits.length, hits };
  });
}
