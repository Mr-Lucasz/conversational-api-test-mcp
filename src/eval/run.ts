import { collectAssertFailures } from "../assertion/assertResponse.js";
import type {
  ApiDefinitionYaml,
  EvalCase,
  EvalDefinition,
} from "../canonical/schema.js";
import { runEndpointWithDefinition } from "../http/runEndpoint.js";
import type { LastHttpResponse } from "../session/SessionStore.js";
import { answerOf } from "./judge.js";

export type EvalRun = {
  ok: boolean;
  failures: string[];
  response?: LastHttpResponse;
};

export type EvalCaseResult = {
  evalCase: EvalCase;
  runs: EvalRun[];
  passed: number;
  passRate: number;
  ok: boolean;
  /** Different answers across the runs (only with `judge.answerPath` and more than one run). */
  distinctAnswers?: number;
};

export type EvalRunInput = {
  workspaceRoot: string;
  def: ApiDefinitionYaml;
  envLocal: Record<string, string>;
  evaluation: EvalDefinition;
  concurrency: number;
  timeoutMs?: number;
};

export function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) {
    return undefined;
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/** One request of the eval. Leaves the session alone: no capture, no last response. */
async function runOnce(input: EvalRunInput, evalCase: EvalCase): Promise<EvalRun> {
  const { evaluation } = input;
  let response: LastHttpResponse | undefined;
  const result = await runEndpointWithDefinition({
    workspaceRoot: input.workspaceRoot,
    def: input.def,
    envLocal: input.envLocal,
    requestId: evaluation.requestId,
    timeoutMs: input.timeoutMs,
    chain: [],
    allow401Retry: true,
    outputOptions: { responseDetail: "minimal" },
    runOptions: {
      variables: Object.fromEntries(
        Object.entries(evalCase.variables ?? {}).map(([k, v]) => [k, String(v)]),
      ),
      ephemeral: true,
      onResponse: (r) => {
        response = r;
      },
    },
  });
  // TS narrows `response` to never here: the assignment happens inside the callback.
  const got = response as LastHttpResponse | undefined;
  if (!got) {
    return { ok: false, failures: [result.ok ? "no response" : result.message] };
  }

  const specs = [evaluation.expect, evalCase.expect].filter((s) => s !== undefined);
  const failures = specs.flatMap((s) => collectAssertFailures(got, s));
  // Nobody said which status to expect: an error status is not a pass.
  if (
    specs.every((s) => s.status === undefined) &&
    (got.status < 200 || got.status >= 300)
  ) {
    failures.unshift(`status ${got.status}`);
  }
  // The endpoint's own `assert` in the YAML.
  if (!result.ok) {
    failures.push(result.message);
  }
  return { ok: failures.length === 0, failures, response: got };
}

/**
 * Send every case `repeat` times. The first request goes alone — it is the one that
 * triggers `auth_dependency` — and the rest a few at a time.
 */
export async function runEval(input: EvalRunInput): Promise<EvalCaseResult[]> {
  const { evaluation } = input;
  const repeat = evaluation.repeat ?? 1;
  const required = evaluation.passRate ?? 1;

  const runsByCase = evaluation.cases.map(() => [] as EvalRun[]);
  const jobs = evaluation.cases.flatMap((_, caseIndex) =>
    Array.from({ length: repeat }, () => caseIndex),
  );
  const work = async (caseIndex: number) => {
    runsByCase[caseIndex].push(
      await runOnce(input, evaluation.cases[caseIndex]),
    );
  };

  const first = jobs.shift();
  if (first !== undefined) {
    await work(first);
  }
  await Promise.all(
    Array.from({ length: input.concurrency }, async () => {
      for (let j = jobs.shift(); j !== undefined; j = jobs.shift()) {
        await work(j);
      }
    }),
  );

  const answerPath = evaluation.judge?.answerPath;
  return evaluation.cases.map((evalCase, i) => {
    const runs = runsByCase[i];
    const passed = runs.filter((r) => r.ok).length;
    const passRate = passed / runs.length;
    const answers =
      answerPath && runs.length > 1
        ? runs.flatMap((r) => {
            const a = r.response && answerOf(r.response.bodyText, answerPath);
            return a === undefined ? [] : [a.trim().toLowerCase().replace(/\s+/g, " ")];
          })
        : [];
    return {
      evalCase,
      runs,
      passed,
      passRate,
      ok: passRate >= required,
      ...(answers.length ? { distinctAnswers: new Set(answers).size } : {}),
    };
  });
}
