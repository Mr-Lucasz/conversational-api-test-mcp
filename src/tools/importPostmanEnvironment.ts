import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { storeSecrets } from "./importCurl.js";
import { safeTool, textResult } from "./toolResult.js";

export const importPostmanEnvironmentInputSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe("Absolute project path (optional when MCP_WORKSPACE_ROOT is set)."),
  legacyRelativePath: z
    .string()
    .optional()
    .describe("A Postman environment (or globals) export in the workspace."),
  legacyContent: z
    .string()
    .optional()
    .describe("The exported JSON, when the user pasted it instead."),
  environment: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .optional()
    .describe(
      "Prefix for the keys, e.g. STAGING → STAGING_base_url, picked when set_environment STAGING is active. Omit to write the keys as they are.",
    ),
});

type PostmanEnvValue = { key?: unknown; value?: unknown; enabled?: boolean; disabled?: boolean };

/** Keys the env file and `{{placeholders}}` both accept. */
const KEY = /^[A-Za-z_][\w.-]*$/;

export function parsePostmanEnvironment(raw: unknown): {
  name?: string;
  values: Record<string, string>;
  skipped: Array<{ key: string; reason: string }>;
} {
  const o = raw as { name?: unknown; values?: unknown; item?: unknown };
  if (!o || typeof o !== "object" || !Array.isArray(o.values) || o.item !== undefined) {
    throw new Error(
      "not a Postman environment export (expected { name, values: [{ key, value }] }); collections go to convert_legacy_to_canonical",
    );
  }
  const values: Record<string, string> = {};
  const skipped: Array<{ key: string; reason: string }> = [];
  for (const v of o.values as PostmanEnvValue[]) {
    const key = typeof v.key === "string" ? v.key.trim() : "";
    if (!key) continue;
    if (v.enabled === false || v.disabled === true) {
      skipped.push({ key, reason: "disabled" });
    } else if (!KEY.test(key)) {
      skipped.push({ key, reason: "name has characters an env file cannot hold" });
    } else if (v.value === undefined || v.value === null || v.value === "") {
      skipped.push({ key, reason: "empty value (Postman does not export current values)" });
    } else {
      values[key] = typeof v.value === "string" ? v.value : JSON.stringify(v.value);
    }
  }
  return { name: typeof o.name === "string" ? o.name : undefined, values, skipped };
}

export async function importPostmanEnvironmentHandler(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = importPostmanEnvironmentInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const { legacyRelativePath, legacyContent, environment } = parsed.data;
    if (Boolean(legacyRelativePath) === Boolean(legacyContent)) {
      throw new Error("give either legacyRelativePath or legacyContent");
    }
    const root = resolve(resolveWorkspaceRoot(parsed.data.workspaceRoot));
    const text = legacyRelativePath
      ? readFileSync(safeResolveUnderWorkspace(root, legacyRelativePath), "utf8")
      : (legacyContent as string);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("the environment export is not valid JSON");
    }
    const env = parsePostmanEnvironment(raw);
    const prefix = environment ? `${environment.toUpperCase()}_` : "";
    const entries = Object.fromEntries(
      Object.entries(env.values).map(([k, v]) => [`${prefix}${k}`, v]),
    );
    const { written, alreadySet } = storeSecrets(root, entries);
    // Values are never echoed back: environments usually hold tokens and passwords.
    return {
      environment: env.name,
      writtenToEnvFile: written,
      ...(alreadySet.length ? { alreadySetKeptAsIs: alreadySet } : {}),
      ...(env.skipped.length ? { skipped: env.skipped } : {}),
      ...(prefix
        ? { next: `call set_environment with "${environment!.toUpperCase()}" to use these values` }
        : {}),
    };
  });
}
