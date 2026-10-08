import { z } from "zod";
import { readApiDefinitionFile } from "../canonical/io.js";
import {
  ASSERT_HINT,
  describeIssues,
  evalDefinitionSchema,
  type EvalDefinition,
} from "../canonical/schema.js";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import { buildJudgePacket } from "../eval/judge.js";
import { percentile, runEval } from "../eval/run.js";
import { safeSliceString } from "../http/safeSlice.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { omitNullish, safeTool, textResult } from "./toolResult.js";

const MAX_FAILURE_ROWS = 20;
const MAX_MESSAGE_CHARS = 300;

// Nested shapes are published shallow (a hint instead of the full schema) to keep
// `tools/list` small; `evalDefinitionSchema` validates them in the handler.
export const runEvalInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  definitionRelativePath: z.string(),
  evalName: z
    .string()
    .optional()
    .describe("Eval declared under `evals:` in the definition. Otherwise pass `requestId` + `cases`."),
  requestId: z.string().optional(),
  cases: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      `Inline cases: {name, variables: {question: "…"}, expect, reference}. expect = ${ASSERT_HINT}`,
    ),
  expect: z.record(z.unknown()).optional().describe("Applied to every case."),
  repeat: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Times each case is sent (default 1, or the eval's)."),
  passRate: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Share of a case's runs that must pass (default 1)."),
  judge: z
    .record(z.unknown())
    .optional()
    .describe(
      "Return samples for you to grade: {answerPath, contextPath, questionVariable, criteria: [faithfulness | relevance | context_relevance | correctness | your own rubric]}.",
    ),
  caseNames: z.array(z.string()).optional().describe("Run only these cases."),
  maxRequests: z
    .number()
    .int()
    .positive()
    .optional()
    .default(30)
    .describe("Refuse to start when cases × repeat exceeds this."),
  concurrency: z.number().int().positive().max(5).optional().default(3),
  timeoutMs: z.number().int().positive().optional(),
});

type Args = z.infer<typeof runEvalInputSchema>;

function resolveEval(
  declared: Record<string, EvalDefinition> | undefined,
  args: Args,
): EvalDefinition {
  let base: Record<string, unknown>;
  if (args.evalName) {
    const found = declared?.[args.evalName];
    if (!found) {
      const known = Object.keys(declared ?? {});
      throw new Error(
        `unknown eval "${args.evalName}"${known.length ? ` (available: ${known.join(", ")})` : " (definition declares no evals)"}`,
      );
    }
    base = found;
  } else if (args.requestId && args.cases?.length) {
    base = { requestId: args.requestId, cases: args.cases };
  } else {
    throw new Error("provide `evalName`, or `requestId` with `cases`");
  }

  const checked = evalDefinitionSchema.safeParse({
    ...base,
    ...omitNullish({
      expect: args.expect,
      repeat: args.repeat,
      passRate: args.passRate,
      judge: args.judge,
    }),
  });
  if (!checked.success) {
    throw new Error(`invalid eval — ${describeIssues(checked.error)}`);
  }
  const evaluation = checked.data;
  if (!args.caseNames) {
    return evaluation;
  }
  const cases = evaluation.cases.filter((c) => args.caseNames?.includes(c.name));
  if (cases.length === 0) {
    throw new Error(
      `no case named ${args.caseNames.join(", ")} (available: ${evaluation.cases.map((c) => c.name).join(", ")})`,
    );
  }
  return { ...evaluation, cases };
}

export async function runEvalHandler(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = runEvalInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    const def = readApiDefinitionFile(
      safeResolveUnderWorkspace(workspaceRoot, parsed.data.definitionRelativePath),
    );
    const evaluation = resolveEval(def.evals, parsed.data);
    if (!def.endpoints.some((e) => e.id === evaluation.requestId)) {
      throw new Error(`Unknown request id: ${evaluation.requestId}`);
    }

    const repeat = evaluation.repeat ?? 1;
    const requests = evaluation.cases.length * repeat;
    if (requests > parsed.data.maxRequests) {
      throw new Error(
        `this eval sends ${requests} requests (${evaluation.cases.length} cases × ${repeat}), over maxRequests ${parsed.data.maxRequests}. Each one is a paid call on an LLM endpoint: ask the user, then raise maxRequests or narrow with caseNames.`,
      );
    }

    const results = await runEval({
      workspaceRoot,
      def,
      envLocal: loadEnvMcpLocalParsed(workspaceRoot),
      evaluation,
      concurrency: parsed.data.concurrency,
      timeoutMs: parsed.data.timeoutMs,
    });

    const durations = results
      .flatMap((r) => r.runs.flatMap((x) => x.response?.durationMs ?? []))
      .sort((a, b) => a - b);
    const showAnswers = results.some((r) => r.distinctAnswers !== undefined);

    // One row per distinct problem of a case, with how many of its runs hit it. The
    // `got "…"` tail quotes the answer, which differs on every run of an endpoint like
    // these: group by what went wrong and keep the first answer as the example.
    const failures = results.flatMap((r) => {
      const byProblem = new Map<string, { message: string; n: number }>();
      for (const message of r.runs.flatMap((x) => x.failures)) {
        const problem = message.split('; got "')[0];
        const seen = byProblem.get(problem);
        if (seen) {
          seen.n++;
        } else {
          byProblem.set(problem, { message, n: 1 });
        }
      }
      return [...byProblem.values()].map(({ message, n }) => ({
        case: r.evalCase.name,
        runs: `${n}/${r.runs.length}`,
        message:
          message.length > MAX_MESSAGE_CHARS
            ? `${safeSliceString(message, MAX_MESSAGE_CHARS)}…`
            : message,
      }));
    });

    const judged = evaluation.judge
      ? results.flatMap((r) => {
          const sample = r.runs.find((x) => x.response)?.response;
          return sample
            ? [{ evalCase: r.evalCase, bodyText: sample.bodyText }]
            : [];
        })
      : [];

    const passedCases = results.filter((r) => r.ok).length;
    return {
      ...(parsed.data.evalName ? { eval: parsed.data.evalName } : {}),
      requestId: evaluation.requestId,
      ok: passedCases === results.length,
      summary: omitNullish({
        cases: results.length,
        passed: passedCases,
        failed: results.length - passedCases,
        requests,
        requiredPassRate: evaluation.passRate ?? 1,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
      }),
      cases: results.map((r) => {
        const own = r.runs
          .flatMap((x) => x.response?.durationMs ?? [])
          .sort((a, b) => a - b);
        return {
          name: r.evalCase.name,
          verdict: r.ok ? "pass" : "fail",
          passed: `${r.passed}/${r.runs.length}`,
          p50Ms: percentile(own, 0.5) ?? "",
          ...(showAnswers ? { distinctAnswers: r.distinctAnswers ?? "" } : {}),
        };
      }),
      ...(failures.length
        ? { failures: failures.slice(0, MAX_FAILURE_ROWS) }
        : {}),
      ...(failures.length > MAX_FAILURE_ROWS
        ? { failuresOmitted: failures.length - MAX_FAILURE_ROWS }
        : {}),
      ...(evaluation.judge && judged.length
        ? { judge: buildJudgePacket(evaluation.judge, judged) }
        : {}),
    };
  });
}
