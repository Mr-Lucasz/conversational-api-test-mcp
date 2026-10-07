import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { parseApiDefinitionYaml } from "../canonical/io.js";
import { safeTool, textResult } from "./toolResult.js";

export const readApiDefinitionInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  relativePath: z
    .string()
    .describe("Path under workspace, e.g. .mcp/api/default.yaml"),
});

export async function readApiDefinitionHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = readApiDefinitionInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const full = safeResolveUnderWorkspace(
      resolveWorkspaceRoot(parsed.data.workspaceRoot),
      parsed.data.relativePath,
    );
    if (!existsSync(full)) {
      throw new Error(`File not found: ${parsed.data.relativePath}`);
    }
    const raw = readFileSync(full, "utf8");
    const def = parseApiDefinitionYaml(raw);
    return { path: parsed.data.relativePath, definition: def };
  });
}
