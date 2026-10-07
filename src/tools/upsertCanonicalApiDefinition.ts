import { existsSync, readFileSync } from "node:fs";
import { normalize, relative, resolve } from "node:path";
import { z } from "zod";
import {
  apiDefinitionYamlSchema,
  endpointSchema,
  type ApiDefinitionYaml,
} from "../canonical/schema.js";
import {
  backupApiDefinitionFileIfExists,
  parseApiDefinitionYaml,
  writeApiDefinitionFileAtomic,
} from "../canonical/io.js";
import { safeResolveMcpApiYaml } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

const createIfMissingSchema = z
  .object({
    version: z.string().optional(),
    service: z.string().optional(),
    name: z.string().optional(),
    base_url: z.string().optional(),
    variables: z.record(z.string(), z.string()).optional(),
  })
  .optional();

export const upsertCanonicalApiDefinitionInputSchema = z
  .object({
    workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
    targetRelativePath: z
      .string()
      .describe(
        "Path under workspace, must be under .mcp/api/, e.g. .mcp/api/weather/staging.yaml",
      ),
    dryRun: z.boolean().optional().default(true),
    confirm: z.boolean().optional(),
    mergeMode: z.enum(["append_endpoints", "replace_file"]),
    replaceDefinition: apiDefinitionYamlSchema.optional(),
    appendEndpoints: z.array(endpointSchema).optional(),
    createIfMissing: createIfMissingSchema,
  })
  .superRefine((data, ctx) => {
    if (data.mergeMode === "replace_file" && data.replaceDefinition === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replaceDefinition is required when mergeMode is replace_file",
        path: ["replaceDefinition"],
      });
    }
    if (data.mergeMode === "append_endpoints") {
      if (!data.appendEndpoints?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "appendEndpoints must be a non-empty array when mergeMode is append_endpoints",
          path: ["appendEndpoints"],
        });
      }
    }
    if (data.dryRun === false && data.confirm !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "confirm must be true when dryRun is false (writes to disk)",
        path: ["confirm"],
      });
    }
  });

function emptyShell(
  createIfMissing: z.infer<typeof createIfMissingSchema>,
): ApiDefinitionYaml {
  return {
    version: createIfMissing?.version ?? "1",
    service: createIfMissing?.service,
    name: createIfMissing?.name,
    base_url: createIfMissing?.base_url,
    variables: createIfMissing?.variables,
    endpoints: [],
  };
}

function toWorkspaceRelative(workspaceRoot: string, absPath: string): string {
  const rel = relative(resolve(normalize(workspaceRoot)), absPath);
  return rel.replace(/\\/g, "/");
}

export async function upsertCanonicalApiDefinitionHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = upsertCanonicalApiDefinitionInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  const d = parsed.data;
  return safeTool(async () => {
    const workspaceRoot = resolveWorkspaceRoot(d.workspaceRoot);
    const abs = safeResolveMcpApiYaml(workspaceRoot, d.targetRelativePath);
    const root = resolve(normalize(workspaceRoot));

    if (d.mergeMode === "replace_file") {
      const next = d.replaceDefinition as ApiDefinitionYaml;
      if (d.dryRun) {
        return {
          dryRun: true,
          targetRelativePath: d.targetRelativePath,
          mergeMode: d.mergeMode,
          wouldWrite: true,
          endpointCount: next.endpoints.length,
          preview: next,
        };
      }
      const backup = backupApiDefinitionFileIfExists(abs);
      writeApiDefinitionFileAtomic(abs, next);
      return {
        dryRun: false,
        targetRelativePath: d.targetRelativePath,
        mergeMode: d.mergeMode,
        written: true,
        backupRelativePath: backup ? toWorkspaceRelative(root, backup) : null,
        endpointCount: next.endpoints.length,
      };
    }

    const append = d.appendEndpoints as NonNullable<typeof d.appendEndpoints>;
    let existing: ApiDefinitionYaml | null = null;
    if (existsSync(abs)) {
      const raw = readFileSync(abs, "utf8");
      existing = parseApiDefinitionYaml(raw);
    }

    let base: ApiDefinitionYaml;
    if (existing) {
      base = existing;
    } else {
      if (!d.createIfMissing) {
        throw new Error(
          "Target file does not exist; provide createIfMissing when using append_endpoints on a new file",
        );
      }
      base = emptyShell(d.createIfMissing);
    }

    const existingIds = new Set(base.endpoints.map((e) => e.id));
    const collisions = append.filter((e) => existingIds.has(e.id)).map((e) => e.id);
    if (collisions.length) {
      throw new Error(
        `append_endpoints: endpoint id(s) already exist in target (rename or remove first): ${collisions.join(", ")}`,
      );
    }

    const merged: ApiDefinitionYaml = {
      ...base,
      endpoints: [...base.endpoints, ...append],
    };

    if (d.dryRun) {
      return {
        dryRun: true,
        targetRelativePath: d.targetRelativePath,
        mergeMode: d.mergeMode,
        wouldWrite: true,
        appendedCount: append.length,
        totalEndpoints: merged.endpoints.length,
        preview: merged,
      };
    }

    const backup = backupApiDefinitionFileIfExists(abs);
    writeApiDefinitionFileAtomic(abs, merged);
    return {
      dryRun: false,
      targetRelativePath: d.targetRelativePath,
      mergeMode: d.mergeMode,
      written: true,
      backupRelativePath: backup ? toWorkspaceRelative(root, backup) : null,
      appendedCount: append.length,
      totalEndpoints: merged.endpoints.length,
    };
  });
}
