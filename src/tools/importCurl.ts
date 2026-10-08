import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  parseApiDefinitionYaml,
  writeApiDefinitionFileAtomic,
} from "../canonical/io.js";
import {
  endpointSchema,
  type ApiDefinitionYaml,
} from "../canonical/schema.js";
import { parseCurl } from "../conversion/curl.js";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import { ENV_FILE_NAME, isEnvFileGitIgnored } from "../vander/onboarding.js";
import { safeResolveMcpApiYaml } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

export const importCurlInputSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe("Absolute project path (optional when MCP_WORKSPACE_ROOT is set)."),
  curl: z.string().min(5).describe("The curl command, exactly as the user pasted it."),
  requestId: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .describe("Id for the new request, e.g. get_user. Letters, digits and underscores."),
  definitionRelativePath: z
    .string()
    .optional()
    .default(".mcp/api/imported.yaml")
    .describe("YAML to create or append to, under .mcp/api/."),
  description: z.string().optional(),
});

function quoteEnvValue(value: string): string {
  if (/^[\w\-.~+/=:@%]*$/.test(value)) {
    return value;
  }
  return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
}

/**
 * Append credentials to `.env.mcp.local` (never overwriting a key) and make sure
 * the file is git-ignored. Returns which variable names were written or already set.
 */
export function storeSecrets(
  root: string,
  secrets: Record<string, string>,
): { written: string[]; alreadySet: string[] } {
  const names = Object.keys(secrets);
  if (names.length === 0) {
    return { written: [], alreadySet: [] };
  }
  const envPath = join(root, ENV_FILE_NAME);
  const existing = loadEnvMcpLocalParsed(root);
  const written = names.filter((n) => !(n in existing));
  if (written.length) {
    const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const lines = written.map((n) => `${n}=${quoteEnvValue(secrets[n] as string)}`);
    appendFileSync(
      envPath,
      `${current && !current.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`,
      "utf8",
    );
  }
  if (!isEnvFileGitIgnored(root)) {
    const gitignore = join(root, ".gitignore");
    const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    appendFileSync(
      gitignore,
      `${current && !current.endsWith("\n") ? "\n" : ""}${ENV_FILE_NAME}\n`,
      "utf8",
    );
  }
  return { written, alreadySet: names.filter((n) => n in existing) };
}

export async function importCurlHandler(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = importCurlInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const { requestId, definitionRelativePath, description } = parsed.data;
    const root = resolve(resolveWorkspaceRoot(parsed.data.workspaceRoot));
    const file = safeResolveMcpApiYaml(root, definitionRelativePath);
    const { origin, endpoint, secrets, losses } = parseCurl(
      parsed.data.curl,
      requestId,
    );

    const exists = existsSync(file);
    const def: ApiDefinitionYaml = exists
      ? parseApiDefinitionYaml(readFileSync(file, "utf8"))
      : { version: "1", base_url: origin, endpoints: [] };
    if (def.endpoints.some((e) => e.id === requestId)) {
      throw new Error(
        `request id "${requestId}" already exists in ${definitionRelativePath}; choose another id`,
      );
    }
    // A file bound to another host (or to a `{{BASE_URL}}` variable) keeps its base_url:
    // the new request then carries its full URL.
    const sameBase = (def.base_url ?? "").replace(/\/+$/, "") === origin;
    const added = endpointSchema.parse({
      id: requestId,
      ...(description ? { description } : {}),
      ...endpoint,
      path: sameBase ? endpoint.path : origin + endpoint.path,
    });
    def.endpoints.push(added);
    writeApiDefinitionFileAtomic(file, def);

    const stored = storeSecrets(root, secrets);
    return {
      definition: definitionRelativePath,
      created: !exists,
      requestId,
      method: added.method,
      url: origin + endpoint.path,
      ...(stored.written.length
        ? { secretsMovedToEnvFile: stored.written }
        : {}),
      ...(stored.alreadySet.length
        ? { secretsAlreadyInEnvFile: stored.alreadySet }
        : {}),
      ...(losses.length ? { losses } : {}),
      next: `Run it with execute_api_request (requestId "${requestId}") or review it with run_vander_checks.`,
    };
  });
}
