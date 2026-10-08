import { z } from "zod";
import { readApiDefinitionFile } from "../canonical/io.js";
import type {
  ApiDefinitionYaml,
  EndpointDefinition,
} from "../canonical/schema.js";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import { buildVanderBrief } from "../prompts/index.js";
import {
  buildVanderPlan,
  type VanderAxis,
  type VanderCheck,
} from "../vander/plan.js";
import {
  renderOnboarding,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from "../vander/onboarding.js";
import { DESTRUCTIVE_SKIP, runVanderChecks } from "../vander/run.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { omitNullish, safeTool, textResult } from "./toolResult.js";

const axisSchema = z.enum(["V", "A", "N", "D", "E", "R"]);

const baseShape = {
  workspaceRoot: z
    .string()
    .optional()
    .describe("Optional when MCP_WORKSPACE_ROOT is set."),
  definitionRelativePath: z.string().describe("e.g. .mcp/api/default.yaml"),
  requestId: z.string(),
  axes: z
    .array(axisSchema)
    .optional()
    .describe("Limit to these VANDER axes (default: all six)."),
};

export const planVanderChecksInputSchema = z.object(baseShape);

export const runVanderChecksInputSchema = z.object({
  ...baseShape,
  includeDestructive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Also send state-changing probes (POST/PUT/PATCH/DELETE)."),
  maxDurationMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1000)
    .describe("Budget for the Responsiveness check."),
  timeoutMs: z.number().int().positive().optional(),
});

export const summonVanderInputSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe(
      "Absolute project path (optional when MCP_WORKSPACE_ROOT is set). Lets Vander greet the user with what the workspace actually contains.",
    ),
  definitionRelativePath: z
    .string()
    .optional()
    .describe("Definition the user wants reviewed, if they named one."),
  requestId: z
    .string()
    .optional()
    .describe("Endpoint id the user wants reviewed, if they named one."),
});

type ToolOutput = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function loadPlan(args: {
  workspaceRoot?: string;
  definitionRelativePath: string;
  requestId: string;
  axes?: VanderAxis[];
}): {
  workspaceRoot: string;
  def: ApiDefinitionYaml;
  ep: EndpointDefinition;
  checks: VanderCheck[];
} {
  const workspaceRoot = resolveWorkspaceRoot(args.workspaceRoot);
  const def = readApiDefinitionFile(
    safeResolveUnderWorkspace(workspaceRoot, args.definitionRelativePath),
  );
  const ep = def.endpoints.find((e) => e.id === args.requestId);
  if (!ep) {
    throw new Error(`Unknown request id: ${args.requestId}`);
  }
  const wanted = args.axes ? new Set(args.axes) : null;
  const checks = buildVanderPlan(def, ep).filter(
    (c) => !wanted || wanted.has(c.axis),
  );
  return { workspaceRoot, def, ep, checks };
}

// Both reports are one flat table (uniform rows are what TOON packs best). The axis
// is the id prefix — `V-`, `A-`, `N-`, `D-`, `E-`, `R-` — so it is not repeated per row.

export async function planVanderChecksHandler(
  args: unknown,
): Promise<ToolOutput> {
  const parsed = planVanderChecksInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const { ep, checks } = loadPlan(parsed.data);
    const rows = checks.map((c) => ({
      id: c.id,
      title: c.title,
      mode:
        c.kind === "manual"
          ? "manual"
          : c.kind === "request" && c.destructive
            ? "destructive"
            : "auto",
    }));
    const count = (m: string) => rows.filter((r) => r.mode === m).length;
    return {
      endpoint: { id: ep.id, method: ep.method, path: ep.path },
      summary: {
        auto: count("auto") + count("destructive"),
        manual: count("manual"),
        destructive: count("destructive"),
      },
      checks: rows,
    };
  });
}

export async function runVanderChecksHandler(
  args: unknown,
): Promise<ToolOutput> {
  const parsed = runVanderChecksInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const { workspaceRoot, def, ep, checks } = loadPlan(parsed.data);
    const results = await runVanderChecks({
      workspaceRoot,
      def,
      envLocal: loadEnvMcpLocalParsed(workspaceRoot),
      ep,
      checks,
      includeDestructive: parsed.data.includeDestructive,
      maxDurationMs: parsed.data.maxDurationMs,
      timeoutMs: parsed.data.timeoutMs,
    });
    const count = (r: string) => results.filter((x) => x.result === r).length;
    const failures = results
      .filter((r) => r.result === "fail")
      .map(({ id, title, expected, actual, note }) =>
        omitNullish({ id, title, expected, actual, note }),
      );
    const heldBack = results.filter((r) =>
      r.note?.startsWith(DESTRUCTIVE_SKIP),
    ).length;
    return {
      endpoint: { id: ep.id, method: ep.method, path: ep.path },
      summary: {
        pass: count("pass"),
        fail: count("fail"),
        skipped: count("skipped"),
        manual: checks.filter((c) => c.kind === "manual").length,
      },
      // `detail` is the evidence: what came back, or why the check did not run.
      checks: results.map((r) => ({
        id: r.id,
        result: r.result,
        detail: (r.result === "skipped" ? r.note : r.actual) ?? "",
      })),
      ...(failures.length ? { failures } : {}),
      ...(heldBack
        ? {
            hint: `${heldBack} state-changing probes not sent; ask the user, then rerun with includeDestructive: true`,
          }
        : {}),
    };
  });
}

/**
 * Returns the Vander brief as plain text, for clients where the user just says "hi Vander".
 * Without a target it adds the onboarding: a workspace snapshot plus Postman-style use cases.
 */
export async function summonVanderHandler(args: unknown): Promise<ToolOutput> {
  const parsed = summonVanderInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  const { workspaceRoot, ...target } = parsed.data;
  if (target.definitionRelativePath || target.requestId) {
    return { content: [{ type: "text", text: buildVanderBrief(target) }] };
  }
  let snapshot: WorkspaceSnapshot | null = null;
  try {
    snapshot = await snapshotWorkspace(resolveWorkspaceRoot(workspaceRoot));
  } catch {
    // no workspace known yet: the brief asks for it
  }
  return {
    content: [
      { type: "text", text: buildVanderBrief({}, renderOnboarding(snapshot)) },
    ],
  };
}
