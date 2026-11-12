import { z } from "zod";
import {
  backupApiDefinitionFileIfExists,
  readApiDefinitionFile,
  writeApiDefinitionFileAtomic,
} from "../canonical/io.js";
import { applyCrudProposals, inferCrudFlows } from "../quality/crud.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

export const inferCrudFlowsInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  definitionRelativePath: z.string(),
  apply: z
    .boolean()
    .optional()
    .default(false)
    .describe("Write the flows (keeps a .bak). Default: propose only."),
});

export async function inferCrudFlowsHandler(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = inferCrudFlowsInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    const file = safeResolveUnderWorkspace(workspaceRoot, parsed.data.definitionRelativePath);
    const def = readApiDefinitionFile(file);
    const proposals = inferCrudFlows(def);
    if (!proposals.length) {
      return {
        flows: [],
        hint: "no POST /things with a matching /things/{{id}} endpoint (or every crud_* flow already exists)",
      };
    }
    let backup: string | null = null;
    if (parsed.data.apply) {
      backup = backupApiDefinitionFileIfExists(file);
      writeApiDefinitionFileAtomic(file, applyCrudProposals(def, proposals));
    }
    return {
      applied: parsed.data.apply,
      flows: proposals.map((p) => ({
        flowName: p.flowName,
        steps: p.steps.map((s) => (typeof s === "string" ? s : `${s.requestId} (expects 404/410)`)).join(" → "),
        notes: p.notes.join("; "),
      })),
      ...(backup ? { backup } : {}),
      next: parsed.data.apply
        ? "run one with execute_api_flow flowName, or `run --flow crud_<name>` in CI"
        : "call again with apply: true to write them (ask the user: the flow creates and deletes real data)",
    };
  });
}
