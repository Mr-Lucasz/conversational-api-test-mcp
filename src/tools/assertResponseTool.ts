import { z } from "zod";
import { assertOnResponse } from "../assertion/assertResponse.js";
import { getLastResponse } from "../session/SessionStore.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

export const assertResponseInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  status: z.number().int().optional(),
  jsonPathExists: z.string().optional(),
});

export async function assertResponseHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = assertResponseInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    const last = getLastResponse(workspaceRoot);
    if (!last) {
      throw new Error("No last HTTP response in session; run execute_api_request first.");
    }
    const r = assertOnResponse(last, {
      status: parsed.data.status,
      jsonPathExists: parsed.data.jsonPathExists,
    });
    if (!r.ok) {
      throw new Error(r.message);
    }
    return { ok: true };
  });
}
