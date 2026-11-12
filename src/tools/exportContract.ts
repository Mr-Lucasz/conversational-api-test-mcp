import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { readApiDefinitionFile } from "../canonical/io.js";
import { buildArazzo, buildOpenApi, buildPact } from "../contract/export.js";
import { mockAnswerFor } from "../cli/mock.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

export const exportContractInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  definitionRelativePath: z.string(),
  format: z.enum(["openapi", "arazzo", "pact"]),
  consumer: z.string().optional(),
  overwrite: z.boolean().optional().default(false),
});

function write(file: string, text: string, overwrite: boolean): void {
  if (existsSync(file) && !overwrite) {
    throw new Error(`${file} exists; pass overwrite: true to replace it`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

export async function exportContractHandler(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = exportContractInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const { definitionRelativePath, format, overwrite } = parsed.data;
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    const def = readApiDefinitionFile(safeResolveUnderWorkspace(workspaceRoot, definitionRelativePath));
    const stem = basename(definitionRelativePath).replace(/\.ya?ml$/i, "");
    const dir = join(workspaceRoot, ".mcp", "contracts");
    const rel = (f: string) => relative(workspaceRoot, f).replaceAll("\\", "/");
    const written: string[] = [];
    let notes: string[] = [];

    if (format === "openapi" || format === "arazzo") {
      const openapiFile = join(dir, `${stem}.openapi.yaml`);
      const doc = buildOpenApi(def, { workspaceRoot, outFile: openapiFile });
      // Arazzo needs the OpenAPI it points at; refresh it alongside.
      write(openapiFile, stringifyYaml(doc, { lineWidth: 0 }), overwrite || format === "arazzo");
      written.push(rel(openapiFile));
      if (format === "arazzo") {
        const arazzoFile = join(dir, `${stem}.arazzo.yaml`);
        const built = buildArazzo(def, `./${basename(openapiFile)}`);
        notes = built.notes;
        write(arazzoFile, stringifyYaml(built.doc, { lineWidth: 0 }), overwrite);
        written.push(rel(arazzoFile));
      }
    } else {
      const pactFile = join(dir, `${stem}.pact.json`);
      const built = buildPact(def, {
        consumer: parsed.data.consumer ?? "consumer",
        responseBody: (ep) => {
          const a = mockAnswerFor(ep, workspaceRoot, {});
          return a.source === "empty" ? { source: "none" } : { body: a.body, source: a.source };
        },
      });
      notes = built.notes;
      write(pactFile, `${JSON.stringify(built.doc, null, 2)}\n`, overwrite);
      written.push(rel(pactFile));
    }
    return {
      written,
      ...(notes.length ? { notes } : {}),
      review:
        format === "pact"
          ? "draft consumer contract: keep only the interactions and fields the consumer really uses before publishing it to a broker"
          : "draft generated from the YAML: review it before treating it as the source of truth",
    };
  });
}
