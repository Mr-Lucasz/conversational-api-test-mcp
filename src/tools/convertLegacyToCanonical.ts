import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { writeApiDefinitionFileAtomic } from "../canonical/io.js";
import type { ApiDefinitionYaml } from "../canonical/schema.js";
import { parseLegacyToCanonical } from "../conversion/ParserFactory.js";
import { isSensitiveName } from "../http/redact.js";
import {
  safeResolveMcpApiYaml,
  safeResolveUnderWorkspace,
} from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { storeSecrets } from "./importCurl.js";
import { safeTool, textResult } from "./toolResult.js";

export const convertLegacyToCanonicalInputSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe("Absolute project path (optional when MCP_WORKSPACE_ROOT is set)."),
  legacyRelativePath: z
    .string()
    .optional()
    .describe("Path to a Postman / OpenAPI / Insomnia file in the workspace."),
  legacyContent: z
    .string()
    .optional()
    .describe(
      "The collection / spec itself (JSON or YAML text), when the user pasted it instead of pointing at a file. Provide this or legacyRelativePath.",
    ),
  outputRelativePath: z
    .string()
    .optional()
    .describe("Where to write, under .mcp/api/. Defaults to .mcp/api/imported.yaml"),
  serviceName: z.string().optional(),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace outputRelativePath if it already exists."),
});

function parseText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return parseYaml(text) as unknown;
  }
}

function variableName(id: string, name: string): string {
  return `${id}_${name}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** Replace literal credentials in headers / auth by `{{VARIABLE}}`; returns what was lifted. */
export function liftLiteralSecrets(def: ApiDefinitionYaml): Record<string, string> {
  const secrets: Record<string, string> = {};
  const lift = (id: string, name: string, value: string): string => {
    const key = variableName(id, name);
    secrets[key] = value;
    return `{{${key}}}`;
  };
  for (const ep of def.endpoints) {
    if (ep.auth && !ep.auth.includes("{{")) {
      const scheme = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(ep.auth);
      ep.auth = scheme
        ? `${scheme[1]} ${lift(ep.id, "TOKEN", scheme[2] as string)}`
        : lift(ep.id, "AUTHORIZATION", ep.auth);
    }
    for (const [name, value] of Object.entries(ep.headers ?? {})) {
      if (isSensitiveName(name) && value && !value.includes("{{")) {
        (ep.headers as Record<string, string>)[name] = lift(ep.id, name, value);
      }
    }
  }
  return secrets;
}

export async function convertLegacyToCanonicalHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = convertLegacyToCanonicalInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const { legacyRelativePath, legacyContent } = parsed.data;
    if (Boolean(legacyRelativePath) === Boolean(legacyContent)) {
      throw new Error("provide exactly one of legacyRelativePath or legacyContent");
    }
    const root = resolve(resolveWorkspaceRoot(parsed.data.workspaceRoot));
    const outRel = parsed.data.outputRelativePath ?? ".mcp/api/imported.yaml";
    const outAbs = safeResolveMcpApiYaml(root, outRel);
    if (existsSync(outAbs) && !parsed.data.overwrite) {
      throw new Error(
        `${outRel} already exists; choose another outputRelativePath or pass overwrite: true`,
      );
    }

    const raw = legacyContent
      ? legacyContent
      : readFileSync(
          safeResolveUnderWorkspace(root, legacyRelativePath as string),
          "utf8",
        );
    const result = parseLegacyToCanonical(parseText(raw), {
      serviceName: parsed.data.serviceName,
    });
    const stored = storeSecrets(root, liftLiteralSecrets(result.canonical));
    writeApiDefinitionFileAtomic(outAbs, result.canonical);
    return {
      outputPath: outRel,
      source: result.sourceLabel,
      losses: result.losses,
      endpointCount: result.canonical.endpoints.length,
      ...(stored.written.length
        ? { secretsMovedToEnvFile: stored.written }
        : {}),
      ...(stored.alreadySet.length
        ? { secretsAlreadyInEnvFile: stored.alreadySet }
        : {}),
    };
  });
}
