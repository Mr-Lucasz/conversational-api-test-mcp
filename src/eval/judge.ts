import { asText, listAt, NO_MATCH, valueAt } from "../assertion/assertResponse.js";
import type { EvalCase, EvalJudge } from "../canonical/schema.js";
import { redactJsonText, truncateBody } from "../http/redact.js";

const MAX_ANSWER_CHARS = 1_200;
const MAX_PASSAGE_CHARS = 500;
const MAX_PASSAGES = 4;

const CRITERIA: Record<string, string> = {
  faithfulness:
    "Every factual claim in the answer is supported by the context. A claim the context does not support fails, even if it is true.",
  relevance:
    "The answer addresses the question that was asked, without evading it or padding.",
  context_relevance:
    "The retrieved passages are about the question; a passage that would not help answer it counts against.",
  correctness:
    "The answer agrees with the reference on the facts that matter.",
};

/** The answer text at `answerPath`, or undefined when the body has none. */
export function answerOf(bodyText: string, answerPath: string): string | undefined {
  try {
    const hit = valueAt(JSON.parse(bodyText), answerPath);
    return hit === NO_MATCH ? undefined : asText(hit);
  } catch {
    return undefined;
  }
}

/**
 * What the agent needs to grade what code cannot: the rubric and, per case, the
 * question, the answer and the passages it was built from. Capped — a judge packet
 * is the largest thing this server returns.
 */
export function buildJudgePacket(
  judge: EvalJudge,
  samples: Array<{ evalCase: EvalCase; bodyText: string }>,
): Record<string, unknown> {
  const hasReference = samples.some((s) => s.evalCase.reference !== undefined);
  const names = judge.criteria ?? [
    ...(judge.contextPath ? ["faithfulness"] : []),
    "relevance",
    ...(hasReference ? ["correctness"] : []),
  ];

  return {
    note: "Not verified by code. Grade each sample against every criterion yourself: pass or fail, quoting the passage or sentence that decides it. Report these verdicts apart from the code-verified results above and say they are your own judgement.",
    criteria: names.map((n) => (CRITERIA[n] ? `${n}: ${CRITERIA[n]}` : n)),
    samples: samples.map(({ evalCase, bodyText }) => {
      const redacted = redactJsonText(bodyText);
      const vars = evalCase.variables ?? {};
      const question =
        judge.questionVariable !== undefined
          ? String(vars[judge.questionVariable] ?? "")
          : Object.entries(vars)
              .map(([k, v]) => `${k}=${v}`)
              .join("; ");
      let passages: unknown[] = [];
      if (judge.contextPath) {
        try {
          passages = listAt(JSON.parse(redacted), judge.contextPath);
        } catch {
          // not JSON: no context to show
        }
      }
      return {
        case: evalCase.name,
        question,
        answer: truncateBody(
          answerOf(redacted, judge.answerPath) ?? "(no answer at answerPath)",
          MAX_ANSWER_CHARS,
        ),
        ...(judge.contextPath
          ? {
              context: passages
                .slice(0, MAX_PASSAGES)
                .map((p) => truncateBody(asText(p), MAX_PASSAGE_CHARS)),
            }
          : {}),
        ...(passages.length > MAX_PASSAGES
          ? { contextOmitted: passages.length - MAX_PASSAGES }
          : {}),
        ...(evalCase.reference !== undefined
          ? { reference: evalCase.reference }
          : {}),
      };
    }),
  };
}
