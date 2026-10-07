import { z } from "zod";
import { maskIfSensitive } from "../http/redact.js";
import { getSessionVariable } from "../session/SessionStore.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

export const getEnvironmentVariableInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  name: z.string(),
});

export async function getEnvironmentVariableHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = getEnvironmentVariableInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    const v = getSessionVariable(
      workspaceRoot,
      parsed.data.name,
    );
    if (v === undefined) {
      return { name: parsed.data.name, value: null };
    }
    const shown = maskIfSensitive(parsed.data.name, v);
    return {
      name: parsed.data.name,
      value: shown,
      ...(shown === v ? {} : { masked: true }),
    };
  });
}
