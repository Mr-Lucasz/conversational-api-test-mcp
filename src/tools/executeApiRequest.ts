import { z } from "zod";
import { executeEndpointById } from "../http/runEndpoint.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

export const executeApiRequestInputSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe("Optional when MCP_WORKSPACE_ROOT is set."),
  definitionRelativePath: z
    .string()
    .describe("e.g. .mcp/api/default.yaml"),
  requestId: z.string(),
  timeoutMs: z.number().int().positive().optional(),
  responseDetail: z
    .enum(["minimal", "summary", "full"])
    .optional()
    .default("summary"),
  jsonPathSelect: z.string().optional().describe("JSONPath to project the response body before returning it."),
  maxBodyChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Character cap for bodyPreview (and for the projection preview when jsonPathSelect is used)."),
});

export async function executeApiRequestHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = executeApiRequestInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const r = await executeEndpointById({
      workspaceRoot: resolveWorkspaceRoot(parsed.data.workspaceRoot),
      definitionRelativePath: parsed.data.definitionRelativePath,
      requestId: parsed.data.requestId,
      timeoutMs: parsed.data.timeoutMs,
      outputOptions: {
        responseDetail: parsed.data.responseDetail,
        jsonPathSelect: parsed.data.jsonPathSelect,
        maxBodyChars: parsed.data.maxBodyChars,
      },
    });
    if (!r.ok) {
      throw new Error(r.message);
    }
    return r;
  });
}
