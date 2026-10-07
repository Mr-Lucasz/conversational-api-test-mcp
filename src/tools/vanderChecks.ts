import { z } from "zod";
import { readApiDefinitionFile } from "../canonical/io.js";
import type {
  ApiDefinitionYaml,
  EndpointDefinition,
} from "../canonical/schema.js";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import {
  VANDER_AXES,
  buildVanderPlan,
  type VanderAxis,
  type VanderCheck,
} from "../vander/plan.js";
import { runVanderChecks } from "../vander/run.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

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

function groupByAxis<T>(
  items: T[],
  axisOf: (item: T) => VanderAxis,
): Array<{ axis: VanderAxis; name: string; checks: T[] }> {
  return VANDER_AXES.map(({ key, name }) => ({
    axis: key,
    name,
    checks: items.filter((i) => axisOf(i) === key),
  })).filter((g) => g.checks.length > 0);
}

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
      axis: c.axis,
      title: c.title,
      mode: c.kind === "manual" ? "manual" : "auto",
      destructive: c.kind === "request" && c.destructive,
    }));
    return {
      endpoint: { id: ep.id, method: ep.method, path: ep.path },
      summary: {
        auto: rows.filter((r) => r.mode === "auto").length,
        manual: rows.filter((r) => r.mode === "manual").length,
        destructive: rows.filter((r) => r.destructive).length,
      },
      axes: groupByAxis(rows, (r) => r.axis).map((g) => ({
        ...g,
        checks: g.checks.map(({ id, title, mode, destructive }) => ({
          id,
          title,
          mode,
          destructive,
        })),
      })),
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
    const axisOf = new Map(checks.map((c) => [c.id, c.axis]));
    const count = (r: string) => results.filter((x) => x.result === r).length;
    return {
      endpoint: { id: ep.id, method: ep.method, path: ep.path },
      summary: {
        pass: count("pass"),
        fail: count("fail"),
        skipped: count("skipped"),
        manual: checks.filter((c) => c.kind === "manual").length,
      },
      axes: groupByAxis(results, (r) => axisOf.get(r.id) as VanderAxis),
    };
  });
}
