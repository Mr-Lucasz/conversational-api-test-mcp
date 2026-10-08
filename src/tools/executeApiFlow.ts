import { z } from "zod";
import { JSONPath } from "jsonpath-plus";
import { readApiDefinitionFile } from "../canonical/io.js";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import { runEndpointWithDefinition, type ExecuteOutputOptions } from "../http/runEndpoint.js";
import { redactJsonText } from "../http/redact.js";
import { getLastResponse } from "../session/SessionStore.js";
import { assertOnResponse } from "../assertion/assertResponse.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { omitNullish, safeTool, textResult } from "./toolResult.js";
import type { ExecuteResult } from "../http/executeTypes.js";
import {
  ASSERT_HINT,
  flowStepSchema,
  type ApiDefinitionYaml,
  type FlowStep,
} from "../canonical/schema.js";

const flowShape = {
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  definitionRelativePath: z.string(),
  steps: z
    .array(flowStepSchema)
    .min(1)
    .optional()
    .describe("Inline steps. Provide either `steps` or `flowName`."),
  flowName: z
    .string()
    .optional()
    .describe("Name of a flow declared under `flows:` in the definition."),
  responseDetail: z
    .enum(["minimal", "summary", "per_step"])
    .optional()
    .default("summary")
    .describe(
      "minimal: requestId/ok/status per step. summary: + durationMs and captured values. per_step: + each step's body (capped). A step's own `jsonPathSelect` returns its body at any level.",
    ),
  stopOnError: z.boolean().optional().default(true),
};

export const executeApiFlowInputSchema = z.object(flowShape);

/** Published in `tools/list`: the step `assert` as a hint, not the whole check schema. */
export const executeApiFlowToolSchema = z.object({
  ...flowShape,
  steps: z
    .array(
      flowStepSchema.extend({
        assert: z.record(z.unknown()).optional().describe(ASSERT_HINT),
      }),
    )
    .min(1)
    .optional()
    .describe("Inline steps. Provide either `steps` or `flowName`."),
});

/** Cap do corpo devolvido por step — um flow soma vários. */
const STEP_BODY_CHARS = 2_000;

function isStatusAccepted(status: number, acceptStatus?: number[]): boolean {
  if (acceptStatus && acceptStatus.length > 0) {
    return acceptStatus.includes(status);
  }
  return status >= 200 && status < 300;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function evalJsonPathOnLastResponse(
  workspaceRoot: string,
  untilJsonPath: string,
): boolean {
  const last = getLastResponse(workspaceRoot);
  if (!last) return false;
  let data: unknown;
  try {
    data = JSON.parse(last.bodyText) as unknown;
  } catch {
    return false;
  }
  const results = JSONPath({
    path: untilJsonPath,
    json: data as object,
    wrap: false,
  });
  if (results === undefined || results === null) return false;
  if (Array.isArray(results)) return results.length > 0;
  if (results === false) return false;
  if (typeof results === "number") return results !== 0;
  if (typeof results === "string") return results.length > 0;
  return Boolean(results);
}

function resolveSteps(
  def: ApiDefinitionYaml,
  inlineSteps: FlowStep[] | undefined,
  flowName: string | undefined,
): FlowStep[] {
  if (inlineSteps && flowName) {
    throw new Error("provide either `steps` or `flowName`, not both");
  }
  if (inlineSteps) {
    return inlineSteps;
  }
  if (!flowName) {
    throw new Error("provide `steps` or `flowName`");
  }
  const flow = def.flows?.[flowName];
  if (!flow) {
    const known = Object.keys(def.flows ?? {});
    throw new Error(
      `unknown flow "${flowName}"${known.length ? ` (available: ${known.join(", ")})` : " (definition declares no flows)"}`,
    );
  }
  if (!flow.steps?.length) {
    throw new Error(`flow "${flowName}" has no steps`);
  }
  return flow.steps.map((s) =>
    typeof s === "string" ? { requestId: s, optional: false } : s,
  );
}

function summarizeCaptureIds(
  steps: Array<{ captureApplied: Record<string, string> }>,
): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    for (const k of Object.keys(s.captureApplied ?? {})) out.add(k);
  }
  return [...out];
}

export async function executeApiFlowHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = executeApiFlowInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }

  return safeTool(async () => {
    const {
      workspaceRoot: workspaceRootArg,
      definitionRelativePath,
      steps: inlineSteps,
      flowName,
      responseDetail,
      stopOnError,
    } = parsed.data;

    const workspaceRoot = resolveWorkspaceRoot(workspaceRootArg);
    const filePath = safeResolveUnderWorkspace(
      workspaceRoot,
      definitionRelativePath,
    );

    const def: ApiDefinitionYaml = readApiDefinitionFile(filePath);
    const envLocal = loadEnvMcpLocalParsed(workspaceRoot);
    const steps = resolveSteps(def, inlineSteps, flowName);

    const stepResults: Array<{
      requestId: string;
      ok: boolean;
      status?: number;
      durationMs?: number;
      captureApplied: Record<string, string>;
      captureErrors: string[];
      errorPreview?: string;
      body?: unknown;
    }> = [];

    let okOverall = true;

    for (const step of steps) {
      const { requestId, optional, retry, poll, acceptStatus, assert } = step;

      const wantsBody =
        step.jsonPathSelect !== undefined || responseDetail === "per_step";
      const outputOptions: ExecuteOutputOptions =
        responseDetail === "minimal" && !wantsBody
          ? { responseDetail: "minimal" }
          : {
              responseDetail: "summary",
              maxBodyChars: STEP_BODY_CHARS,
              jsonPathSelect: step.jsonPathSelect,
            };

      const retryMax = retry?.max ?? 1;
      const retryDelayMs = retry?.delayMs ?? 0;

      let last: ExecuteResult | null = null;
      let lastOk = false;

      for (let attempt = 1; attempt <= retryMax; attempt++) {
        // Uma execução “atômica” do requestId (com auth/captura já incluso pelo engine).
        const execOnce = async (): Promise<ExecuteResult> =>
          runEndpointWithDefinition({
            workspaceRoot,
            def,
            envLocal,
            requestId,
            timeoutMs: undefined,
            chain: [],
            allow401Retry: true,
            outputOptions,
          });

        last = await execOnce();

        // Se houver polling, reexecuta até o jsonPath existir.
        let pollOk = true;
        if (poll && last.ok) {
          pollOk = false;
          for (let i = 0; i < poll.maxAttempts; i++) {
            pollOk = evalJsonPathOnLastResponse(
              workspaceRoot,
              poll.untilJsonPath,
            );
            if (pollOk) break;
            if (i < poll.maxAttempts - 1) {
              const d = poll.delayMs ?? 0;
              if (d > 0) await sleep(d);
              last = await execOnce();
              if (!last.ok) break;
            }
          }
        } else if (poll && !last.ok) {
          pollOk = false;
        }

        lastOk =
          last.ok &&
          pollOk &&
          isStatusAccepted(last.status, acceptStatus);

        if (lastOk) break;

        if (attempt < retryMax && retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
      }

      // Assert inline (status/jsonPathExists) sobre a última resposta do step — evita
      // um round trip extra de assert_response após o flow.
      let assertMessage: string | undefined;
      if (lastOk && assert) {
        const lastResp = getLastResponse(workspaceRoot);
        const ar = lastResp
          ? assertOnResponse(lastResp, assert)
          : { ok: false as const, message: "no response captured for assert" };
        if (!ar.ok) {
          lastOk = false;
          assertMessage = ar.message;
        }
      }

      // O corpo do step vem em `bodyJson` (JSON que coube no cap) ou `bodyPreview`.
      const stepBody =
        last && last.ok
          ? last.bodyPreviewTruncated
            ? last.bodyPreview
            : (last.bodyJson ?? last.bodyPreview)
          : undefined;

      const summaryErrorPreview =
        assertMessage ??
        (last && last.ok
          ? stepBody === undefined
            ? // `minimal` não traz corpo; num step que falhou ele poupa a chamada de diagnóstico.
              redactJsonText(
                getLastResponse(workspaceRoot)?.bodyText ?? "",
              ).slice(0, 400) || undefined
            : (typeof stepBody === "string"
                ? stepBody
                : JSON.stringify(stepBody)
              ).slice(0, 400)
          : last && !last.ok
            ? last.message
            : undefined);

      stepResults.push({
        requestId,
        ok: lastOk,
        status: last && last.ok ? last.status : undefined,
        durationMs: last && last.ok ? last.durationMs : undefined,
        captureApplied: last && last.ok ? (last.captureApplied ?? {}) : {},
        captureErrors: last && last.ok ? (last.captureErrors ?? []) : ["exec-failed"],
        errorPreview: lastOk ? undefined : summaryErrorPreview,
        // Num step que falhou o corpo já está em `errorPreview`.
        body: lastOk && wantsBody ? stepBody : undefined,
      });

      if (!lastOk && !optional) {
        okOverall = false;
        if (stopOnError) break;
      }
    }

    const captured = summarizeCaptureIds(
      stepResults.map((s) => ({ captureApplied: s.captureApplied })),
    );

    const okSteps = stepResults.filter((s) => s.ok).length;
    const failedSteps = stepResults.length - okSteps;

    // Omite captureApplied/captureErrors por step quando vazios — comum quando o
    // endpoint não define `capture` — em vez de pagar `{}`/`[]` em cada step do flow.
    // `minimal` também corta duração e valores capturados (os nomes seguem em `summary`).
    const stepsOut = stepResults.map((s) => {
      const { captureApplied, captureErrors, durationMs, ...rest } = s;
      const lean = responseDetail === "minimal";
      return omitNullish({
        ...rest,
        ...(lean ? {} : { durationMs }),
        ...(!lean && Object.keys(captureApplied).length > 0
          ? { captureApplied }
          : {}),
        ...(captureErrors.length > 0 ? { captureErrors } : {}),
      });
    });

    return {
      ok: okOverall,
      summary: {
        okSteps,
        failedSteps,
        capturedVariables: captured,
      },
      steps: stepsOut,
    };
  });
}

