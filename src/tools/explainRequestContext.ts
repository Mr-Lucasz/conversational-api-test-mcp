import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import { getSession } from "../session/SessionStore.js";
import { parseApiDefinitionYaml } from "../canonical/io.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { safeTool, textResult } from "./toolResult.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";

export const explainRequestContextInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  definitionRelativePath: z.string(),
  requestId: z.string().optional(),
});

export async function explainRequestContextHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = explainRequestContextInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    const full = safeResolveUnderWorkspace(
      workspaceRoot,
      parsed.data.definitionRelativePath,
    );
    if (!existsSync(full)) {
      throw new Error(`File not found: ${parsed.data.definitionRelativePath}`);
    }
    const raw = readFileSync(full, "utf8");
    const def = parseApiDefinitionYaml(raw);
    const envKeys = Object.keys(
      loadEnvMcpLocalParsed(workspaceRoot),
    );
    const sess = getSession(workspaceRoot);
    const ep = parsed.data.requestId
      ? def.endpoints.find((e) => e.id === parsed.data.requestId)
      : undefined;
    const currentEnv = sess.variables.CURRENT_ENV;
    return {
      service: def.service ?? def.name,
      base_url: def.base_url,
      yamlVariableKeys: Object.keys(def.variables ?? {}),
      envMcpLocalKeys: envKeys,
      sessionVariableKeys: Object.keys(sess.variables),
      currentEnvironment: currentEnv ?? null,
      hasLastResponse: Boolean(sess.lastResponse),
      endpoint: ep ?? null,
    };
  });
}
