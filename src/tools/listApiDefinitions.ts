import { glob } from "tinyglobby";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { mcpApiDir } from "../workspace/paths.js";
import { safeTool, textResult } from "./toolResult.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { pickFields } from "./pickFields.js";

const defaultGlob = "**/*.{yaml,yml}";

export const listApiDefinitionsInputSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe("Absolute path to the project root (optional when MCP_WORKSPACE_ROOT is set)."),
  globPattern: z
    .string()
    .optional()
    .describe(
      `glob pattern relative to .mcp/api/ (default "${defaultGlob}")`,
    ),
  includeCatalogMeta: z
    .boolean()
    .optional()
    .describe(
      "When true, reads `.mcp/api/_catalog.yaml` (if present) and returns service/summary per path.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Case-insensitive substring filter on path and, when available, on service/summary from _catalog.yaml.",
    ),
  maxFiles: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap the number of paths returned after sorting (page size when combined with cursor)."),
  sortBy: z
    .enum(["path", "mtime_asc", "mtime_desc"])
    .optional()
    .default("path")
    .describe("Sort order before applying maxFiles"),
  cursor: z
    .string()
    .optional()
    .describe(
      "Cursor opaco de `nextCursor` de uma chamada anterior; retoma a listagem daí em vez de rescanear desde o início. Sem cursor = primeira página.",
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "When given, projects each `entries` item to these keys only (path/service/summary). No effect on `files` (list of strings).",
    ),
});

export async function listApiDefinitionsHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = listApiDefinitionsInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const root = resolve(resolveWorkspaceRoot(parsed.data.workspaceRoot));
    const apiDir = mcpApiDir(root);
    if (!existsSync(apiDir)) {
      return {
        workspaceRoot: root,
        apiDir,
        files: [] as string[],
        totalMatched: 0,
        truncated: false,
      };
    }
    const pattern = parsed.data.globPattern ?? defaultGlob;
    const absFiles = await glob(pattern, {
      cwd: apiDir,
      onlyFiles: true,
      absolute: true,
      ignore: ["**/node_modules/**"],
    });
    const relFiles = absFiles.map((f) => relative(root, f).replace(/\\/g, "/"));

    const ordered: { abs: string; rel: string }[] = absFiles.map((abs, i) => ({
      abs,
      rel: relFiles[i] as string,
    }));

    const sortBy = parsed.data.sortBy ?? "path";
    if (sortBy === "path") {
      ordered.sort((a, b) => a.rel.localeCompare(b.rel));
    } else if (sortBy === "mtime_asc" || sortBy === "mtime_desc") {
      ordered.sort((a, b) => {
        const ta = statSync(a.abs).mtimeMs;
        const tb = statSync(b.abs).mtimeMs;
        return sortBy === "mtime_asc" ? ta - tb : tb - ta;
      });
    }

    const includeCatalogMeta = parsed.data.includeCatalogMeta ?? false;
    const query = parsed.data.query?.trim().toLowerCase();

    let catalogByPath:
      | Map<string, { service?: string; summary?: string }>
      | null = null;

    if (includeCatalogMeta || query) {
      const catalogPath = join(apiDir, "_catalog.yaml");
      if (existsSync(catalogPath)) {
        const raw = parseYaml(
          readFileSync(catalogPath, "utf8"),
          { merge: true },
        ) as Record<string, unknown> | null;

        const defs = (raw?.definitions as Array<unknown> | undefined) ?? [];
        catalogByPath = new Map(
          defs
            .map((d) => d as Record<string, unknown>)
            .filter((d) => typeof d?.path === "string")
            .map((d) => [
              d.path as string,
              {
                service: typeof d.service === "string" ? d.service : undefined,
                summary: typeof d.summary === "string" ? d.summary : undefined,
              },
            ]),
        );
      } else {
        catalogByPath = null;
      }
    }

    const filtered = query
      ? ordered.filter((o) => {
          const meta = catalogByPath?.get(o.rel);
          const service = meta?.service ?? "";
          const summary = meta?.summary ?? "";
          const haystack = `${o.rel} ${service} ${summary}`.toLowerCase();
          return haystack.includes(query);
        })
      : ordered;

    const totalMatched = filtered.length;
    const maxFiles = parsed.data.maxFiles;
    const rawCursor = parsed.data.cursor;

    // Cursor opaco: offset numérico sobre `filtered` (já ordenado/filtrado). Mantém o
    // comportamento antigo (maxFiles sozinho = cap desde o início) quando não há cursor.
    let offset = 0;
    if (rawCursor !== undefined) {
      const parsedOffset = Number(rawCursor);
      if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
        throw new Error(`cursor inválido: ${rawCursor}`);
      }
      offset = parsedOffset;
    }
    const pageSize = maxFiles ?? (rawCursor !== undefined ? 50 : undefined);

    let truncated = false;
    let nextCursor: string | undefined;
    let sliced = filtered.slice(offset);
    if (pageSize !== undefined) {
      const hasMore = offset + pageSize < filtered.length;
      sliced = sliced.slice(0, pageSize);
      truncated = hasMore;
      nextCursor = hasMore ? String(offset + pageSize) : undefined;
    }

    const fields = parsed.data.fields;
    const entries =
      includeCatalogMeta || query
        ? sliced.map((o) => {
            const meta = catalogByPath?.get(o.rel);
            return pickFields(
              { path: o.rel, service: meta?.service, summary: meta?.summary },
              fields,
            );
          })
        : undefined;

    return {
      workspaceRoot: root,
      apiDir,
      files: sliced.map((o) => o.rel),
      totalMatched,
      truncated,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      globPattern: pattern,
      sortBy,
      entries,
    };
  });
}
