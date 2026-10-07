import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { globSync } from "tinyglobby";
import { basename, join, relative, resolve } from "node:path";
import { mergeApiDefinitions, type MergeConflict } from "../canonical/merge.js";
import {
  backupApiDefinitionFileIfExists,
  parseApiDefinitionYaml,
  writeApiDefinitionFileAtomic,
} from "../canonical/io.js";
import type { ApiDefinitionYaml } from "../canonical/schema.js";
import { mcpApiDir, safeResolveMcpApiYaml } from "../workspace/paths.js";
import { safeTool, textResult } from "./toolResult.js";
import { z } from "zod";

const manualGroupSchema = z.object({
  targetRelativePath: z.string(),
  // Glob patterns relative to .mcp/api (e.g. staging-*.yaml); do not prefix .mcp/api in the pattern.
  sourceGlobs: z.array(z.string()).min(1),
});

export const reorganizeMcpApiDefinitionsInputSchema = z
  .object({
    workspaceRoot: z.string(),
    mode: z.enum(["plan", "apply"]),
    groupBy: z.enum(["manual_groups", "same_service_field"]),
    manualGroups: z.array(manualGroupSchema).optional(),
    confirm: z.boolean().optional(),
    deleteSourcesAfterMerge: z.boolean().optional().default(false),
    moveSourcesToArchive: z.boolean().optional().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.groupBy === "manual_groups" && !data.manualGroups?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "manualGroups is required when groupBy is manual_groups",
        path: ["manualGroups"],
      });
    }
    if (data.mode === "apply" && data.confirm !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "confirm must be true when mode is apply",
        path: ["confirm"],
      });
    }
    if (data.deleteSourcesAfterMerge && data.moveSourcesToArchive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "choose at most one of deleteSourcesAfterMerge or moveSourcesToArchive",
        path: ["deleteSourcesAfterMerge"],
      });
    }
  });

type ParsedFile = {
  absolutePath: string;
  relativeToWorkspace: string;
  def: ApiDefinitionYaml;
};

export type PlannedGroup = {
  targetRelativePath: string;
  sourceRelativePaths: string[];
  ready: boolean;
  conflicts: MergeConflict[];
  mergedEndpointCount: number;
};

function workspaceRelative(workspaceRoot: string, abs: string): string {
  return relative(resolve(workspaceRoot), abs).replace(/\\/g, "/");
}

function sanitizeServiceName(service: string): string {
  return service.replace(/[/\\:*?"<>|]+/g, "_").replace(/\s+/g, "-");
}

function collectSourcesForGlobs(
  apiDir: string,
  workspaceRoot: string,
  globs: string[],
): { files: ParsedFile[]; parseErrors: { file: string; error: string }[] } {
  const parseErrors: { file: string; error: string }[] = [];
  const absSeen = new Set<string>();
  const files: ParsedFile[] = [];

  for (const pattern of globs) {
    const hits = globSync(pattern, {
      cwd: apiDir,
      onlyFiles: true,
      absolute: true,
      ignore: ["**/node_modules/**"],
    });
    for (const abs of hits) {
      const lower = abs.toLowerCase();
      if (!lower.endsWith(".yaml") && !lower.endsWith(".yml")) {
        continue;
      }
      if (absSeen.has(abs)) {
        continue;
      }
      absSeen.add(abs);
      const rel = workspaceRelative(workspaceRoot, abs);
      try {
        const raw = readFileSync(abs, "utf8");
        const def = parseApiDefinitionYaml(raw);
        files.push({ absolutePath: abs, relativeToWorkspace: rel, def });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        parseErrors.push({ file: rel, error: msg });
      }
    }
  }
  return { files, parseErrors };
}

/** If the target file is part of the set, put it first so metadata (version, etc.) follows the existing target. */
function orderSourcesForMerge(
  targetRelativePath: string,
  sources: ParsedFile[],
): ParsedFile[] {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const t = norm(targetRelativePath);
  const idx = sources.findIndex((s) => norm(s.relativeToWorkspace) === t);
  if (idx <= 0) {
    return sources;
  }
  const copy = [...sources];
  const [hit] = copy.splice(idx, 1);
  return [hit, ...copy];
}

function planOneGroup(
  _workspaceRoot: string,
  targetRelativePath: string,
  sources: ParsedFile[],
): { planned: PlannedGroup; merged: ApiDefinitionYaml | null } {
  if (sources.length < 2) {
    return {
      planned: {
        targetRelativePath,
        sourceRelativePaths: sources.map((s) => s.relativeToWorkspace),
        ready: false,
        conflicts: [],
        mergedEndpointCount: 0,
      },
      merged: null,
    };
  }
  const ordered = orderSourcesForMerge(targetRelativePath, sources);
  const inputs = ordered.map((s) => ({
    relativePath: s.relativeToWorkspace,
    def: s.def,
  }));
  const { merged, conflicts } = mergeApiDefinitions(inputs);
  return {
    planned: {
      targetRelativePath,
      sourceRelativePaths: sources.map((s) => s.relativeToWorkspace),
      ready: conflicts.length === 0,
      conflicts,
      mergedEndpointCount: merged.endpoints.length,
    },
    merged: conflicts.length === 0 ? merged : null,
  };
}

function buildSameServiceGroups(
  apiDir: string,
  workspaceRoot: string,
): {
  groups: { targetRelativePath: string; files: ParsedFile[] }[];
  parseErrors: { file: string; error: string }[];
} {
  const parseErrors: { file: string; error: string }[] = [];
  const allAbs = globSync("**/*.{yaml,yml}", {
    cwd: apiDir,
    onlyFiles: true,
    absolute: true,
    ignore: [
      "**/node_modules/**",
      "**/_consolidated/**",
      "**/_archive/**",
    ],
  });

  const byService = new Map<string, ParsedFile[]>();
  for (const abs of allAbs) {
    const rel = workspaceRelative(workspaceRoot, abs);
    try {
      const raw = readFileSync(abs, "utf8");
      const def = parseApiDefinitionYaml(raw);
      const svc = def.service?.trim();
      if (!svc) {
        continue;
      }
      if (!byService.has(svc)) {
        byService.set(svc, []);
      }
      byService.get(svc)!.push({
        absolutePath: abs,
        relativeToWorkspace: rel,
        def,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parseErrors.push({ file: rel, error: msg });
    }
  }

  const groups: { targetRelativePath: string; files: ParsedFile[] }[] = [];
  for (const [service, files] of byService) {
    if (files.length < 2) {
      continue;
    }
    groups.push({
      targetRelativePath: `.mcp/api/_consolidated/${sanitizeServiceName(service)}.yaml`,
      files,
    });
  }

  return { groups, parseErrors };
}

export async function reorganizeMcpApiDefinitionsHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = reorganizeMcpApiDefinitionsInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  const d = parsed.data;
  return safeTool(async () => {
    const root = resolve(d.workspaceRoot);
    const apiDir = mcpApiDir(root);
    if (!existsSync(apiDir)) {
      return {
        mode: d.mode,
        message: ".mcp/api directory does not exist",
        groups: [] as PlannedGroup[],
      };
    }

    let parseErrorsAcc: { file: string; error: string }[] = [];
    const planned: PlannedGroup[] = [];
    const mergePayloads: {
      targetRelativePath: string;
      sources: ParsedFile[];
      merged: ApiDefinitionYaml;
    }[] = [];

    if (d.groupBy === "manual_groups") {
      for (const mg of d.manualGroups ?? []) {
        const { files, parseErrors } = collectSourcesForGlobs(
          apiDir,
          d.workspaceRoot,
          mg.sourceGlobs,
        );
        parseErrorsAcc = parseErrorsAcc.concat(parseErrors);
        const { planned: row, merged } = planOneGroup(
          d.workspaceRoot,
          mg.targetRelativePath,
          files,
        );
        planned.push(row);
        if (merged) {
          mergePayloads.push({
            targetRelativePath: mg.targetRelativePath,
            sources: files,
            merged,
          });
        }
      }
    } else {
      const { groups, parseErrors } = buildSameServiceGroups(apiDir, d.workspaceRoot);
      parseErrorsAcc = parseErrorsAcc.concat(parseErrors);
      for (const g of groups) {
        const { planned: row, merged } = planOneGroup(
          d.workspaceRoot,
          g.targetRelativePath,
          g.files,
        );
        planned.push(row);
        if (merged) {
          mergePayloads.push({
            targetRelativePath: g.targetRelativePath,
            sources: g.files,
            merged,
          });
        }
      }
    }

    const blocked = planned.filter((p) => !p.ready && p.sourceRelativePaths.length >= 2);
    const applyBlocked = d.mode === "apply" && blocked.length > 0;

    if (d.mode === "plan" || applyBlocked) {
      return {
        mode: d.mode,
        groupBy: d.groupBy,
        parseErrors: parseErrorsAcc,
        groups: planned,
        applySkippedBecauseConflicts: applyBlocked,
        note: applyBlocked
          ? "apply aborted: fix conflicts (duplicate endpoint ids, base_url, service, or variables) then retry"
          : undefined,
      };
    }

    const archiveDir = join(apiDir, "_archive");
    const written: string[] = [];
    const backups: (string | null)[] = [];
    const removedOrMoved: string[] = [];

    const targetAbsFor = (rel: string) =>
      safeResolveMcpApiYaml(d.workspaceRoot, rel);

    for (const row of mergePayloads) {
      const targetAbs = targetAbsFor(row.targetRelativePath);
      const backup = backupApiDefinitionFileIfExists(targetAbs);
      backups.push(backup ? workspaceRelative(d.workspaceRoot, backup) : null);
      writeApiDefinitionFileAtomic(targetAbs, row.merged);
      written.push(row.targetRelativePath);

      for (const src of row.sources) {
        if (src.absolutePath === targetAbs) {
          continue;
        }
        if (d.moveSourcesToArchive) {
          if (!existsSync(archiveDir)) {
            mkdirSync(archiveDir, { recursive: true });
          }
          const stamp = Date.now();
          const dest = join(archiveDir, `${basename(src.absolutePath)}.${stamp}.yaml`);
          renameSync(src.absolutePath, dest);
          removedOrMoved.push(workspaceRelative(d.workspaceRoot, dest));
        } else if (d.deleteSourcesAfterMerge) {
          unlinkSync(src.absolutePath);
          removedOrMoved.push(src.relativeToWorkspace);
        }
      }
    }

    return {
      mode: "apply",
      groupBy: d.groupBy,
      writtenTargets: written,
      backupsRelative: backups,
      removedOrMoved,
      parseErrors: parseErrorsAcc,
      groups: planned,
    };
  });
}
