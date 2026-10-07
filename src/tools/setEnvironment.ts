import { z } from "zod";
import { setSessionVariable } from "../session/SessionStore.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

const CURRENT_ENV = "CURRENT_ENV";

export const setEnvironmentInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  /** Logical environment name (e.g. DEVELOP, STAGING). Stored uppercase as session CURRENT_ENV. */
  environment: z.string().min(1),
});

export async function setEnvironmentHandler(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = setEnvironmentInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const normalized = parsed.data.environment.trim().toUpperCase();
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    setSessionVariable(workspaceRoot, CURRENT_ENV, normalized);
    return { ok: true, [CURRENT_ENV]: normalized };
  });
}
