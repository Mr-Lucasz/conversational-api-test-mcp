import { z } from "zod";
import { setSessionVariable } from "../session/SessionStore.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

export const setEnvironmentVariableInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  name: z.string(),
  value: z.string(),
});

export async function setEnvironmentVariableHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = setEnvironmentVariableInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    setSessionVariable(
      workspaceRoot,
      parsed.data.name,
      parsed.data.value,
    );
    return { ok: true, name: parsed.data.name };
  });
}
