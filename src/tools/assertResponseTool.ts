import { z } from "zod";
import { collectAssertFailures } from "../assertion/assertResponse.js";
import { assertSpecSchema, describeIssues } from "../canonical/schema.js";
import { getLastResponse } from "../session/SessionStore.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { omitNullish, safeTool, textResult } from "./toolResult.js";

export const assertResponseInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  status: z.number().int().optional(),
  jsonPathExists: z.string().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  checks: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      "Value checks, each {path (JSONPath; omit = whole body), contains | containsAny | notContains | matches | equals | min | max | minLength | maxLength | includesAll | includesAny | subsetOf, ignoreCase, minRatio}.",
    ),
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
    const { status, jsonPathExists, maxDurationMs, checks } = parsed.data;
    const spec = assertSpecSchema.safeParse(
      omitNullish({ status, jsonPathExists, maxDurationMs, checks }),
    );
    if (!spec.success) {
      throw new Error(`invalid assert — ${describeIssues(spec.error)}`);
    }
    const failures = collectAssertFailures(last, spec.data);
    if (failures.length) {
      throw new Error(failures.join("; "));
    }
    return { ok: true };
  });
}
