import { z } from "zod";
import { readApiDefinitionFile } from "../canonical/io.js";
import type { AssertSpec } from "../canonical/schema.js";
import { scoreAssertions, type MutationReport } from "../quality/mutation.js";
import { getLastResponse } from "../session/SessionStore.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { executeApiFlowInputSchema, runApiFlow } from "./executeApiFlow.js";
import { safeTool, textResult } from "./toolResult.js";

export const mutateAssertionsInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  definitionRelativePath: z.string(),
  flowName: z.string().optional().describe("Score every step of this flow."),
  requestId: z.string().optional().describe("Score this request's assert."),
  useLastResponse: z
    .boolean()
    .optional()
    .describe("With requestId: mutate the session's last response instead of sending the request."),
});

const MAX_SURVIVORS = 10;

type StepScore = { requestId: string } & MutationReport;

function specsFor(
  epAssert: AssertSpec | undefined,
  stepAssert: AssertSpec | undefined,
): AssertSpec[] {
  return [epAssert, stepAssert].filter((s): s is AssertSpec => s !== undefined);
}

export async function mutateAssertionsHandler(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = mutateAssertionsInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const { definitionRelativePath, flowName, requestId, useLastResponse } = parsed.data;
    if (Boolean(flowName) === Boolean(requestId)) {
      throw new Error("give either flowName or requestId");
    }
    if (useLastResponse && !requestId) {
      throw new Error("useLastResponse works with requestId");
    }
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    const steps: StepScore[] = [];

    if (useLastResponse) {
      const def = readApiDefinitionFile(safeResolveUnderWorkspace(workspaceRoot, definitionRelativePath));
      const ep = def.endpoints.find((e) => e.id === requestId);
      if (!ep) throw new Error(`Unknown request id: ${requestId}`);
      const last = getLastResponse(workspaceRoot);
      if (!last) throw new Error("no response in this session yet: run the request first");
      steps.push({ requestId: requestId!, ...scoreAssertions(last, specsFor(ep.assert, undefined), workspaceRoot) });
    } else {
      const input = executeApiFlowInputSchema.parse({
        workspaceRoot,
        definitionRelativePath,
        responseDetail: "minimal",
        stopOnError: false,
        ...(flowName ? { flowName } : { steps: [{ requestId }] }),
      });
      await runApiFlow(input, {
        onStep: (step, response, def) => {
          const ep = def.endpoints.find((e) => e.id === step.requestId);
          if (!response) {
            steps.push({
              requestId: step.requestId,
              baselineFailures: ["no response came back"],
              total: 0,
              killed: 0,
              score: 0,
              survivors: [],
            });
            return;
          }
          steps.push({
            requestId: step.requestId,
            ...scoreAssertions(response, specsFor(ep?.assert, step.assert), workspaceRoot),
          });
        },
      });
    }

    const scored = steps.filter((s) => !s.baselineFailures);
    const total = scored.reduce((n, s) => n + s.total, 0);
    const killed = scored.reduce((n, s) => n + s.killed, 0);
    const survivors = scored.flatMap((s) =>
      s.survivors.map((v) => ({
        step: s.requestId,
        change: v.change,
        // One line per row keeps the TOON table flat; it is YAML-ready as JSON.
        addToAssert: JSON.stringify(v.suggestion),
      })),
    );
    return {
      score: total ? Math.round((killed / total) * 100) / 100 : 0,
      killed,
      total,
      steps: steps.map((s) => ({
        requestId: s.requestId,
        score: s.baselineFailures ? "not scored" : s.score,
        killed: s.killed,
        total: s.total,
        note: s.baselineFailures
          ? `asserts already fail on the real response: ${s.baselineFailures.slice(0, 2).join("; ")}`
          : s.total && !s.killed
            ? "no assert noticed any mutation"
            : "",
      })),
      ...(survivors.length
        ? {
            survivors: survivors.slice(0, MAX_SURVIVORS),
            ...(survivors.length > MAX_SURVIVORS
              ? { moreSurvivors: survivors.length - MAX_SURVIVORS }
              : {}),
            hint: "each survivor is a regression the asserts would let through; addToAssert is one way to catch it — keep only checks on stable values (ids and timestamps change between runs)",
          }
        : {}),
    };
  });
}
