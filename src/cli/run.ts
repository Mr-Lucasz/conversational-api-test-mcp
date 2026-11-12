import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { glob } from "tinyglobby";
import { readApiDefinitionFile } from "../canonical/io.js";
import { setSessionVariable } from "../session/SessionStore.js";
import { executeApiFlowInputSchema, runApiFlow } from "../tools/executeApiFlow.js";
import { mcpApiDir } from "../workspace/paths.js";
import { renderJunit, renderPretty, type RunReport, type SuiteResult } from "./report.js";

export const RUN_USAGE = `Usage: conversational-api-test-mcp run [definition.yaml ...] [options]

Runs flows from the YAML definitions in .mcp/api/ (all of them when no file is given)
and exits 1 when a step fails, so it can gate a CI job.

Options:
  --flow <name>        Run this flow (repeatable). Default: every flow in each file.
  --request <id>       Run this request on its own (repeatable).
  --all-endpoints      Run every request of each file, one by one. Sends POST/PUT/DELETE too.
  --env <name>         Active environment, as set_environment (STAGING → STAGING_* vars win).
  --reporter <name>    pretty (default), junit or json.
  --out <file>         Write the report to a file instead of stdout.
  --workspace <dir>    Project root holding .mcp/api/ (default: current directory).
  --bail               Stop at the first failing flow.
  --update-snapshots   Rewrite assert snapshots that differ instead of failing.
  -h, --help           Show this help.`;

export type RunCliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const defaultIo: RunCliIo = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
};

type Target = { suite: string; flowName?: string; requestId?: string };

function targetsFor(
  relPath: string,
  def: ReturnType<typeof readApiDefinitionFile>,
  opts: { flows: string[]; requests: string[]; allEndpoints: boolean },
): Target[] | string {
  const name = def.service ?? def.name ?? relPath;
  const out: Target[] = [];
  const declared = Object.keys(def.flows ?? {});
  const flows = opts.flows.length ? opts.flows.filter((f) => declared.includes(f)) : [];
  if (!opts.flows.length && !opts.requests.length && !opts.allEndpoints) {
    flows.push(...declared);
  }
  for (const flowName of flows) {
    out.push({ suite: `${name} › ${flowName}`, flowName });
  }
  const ids = def.endpoints.map((e) => e.id);
  const requests = opts.allEndpoints ? ids : opts.requests.filter((r) => ids.includes(r));
  for (const requestId of requests) {
    out.push({ suite: `${name} › ${requestId}`, requestId });
  }
  if (out.length) {
    return out;
  }
  if (opts.flows.length || opts.requests.length) {
    return "none of the requested flows / requests are in this file";
  }
  return "declares no flows (pass --request, --flow or --all-endpoints)";
}

async function runTarget(
  workspaceRoot: string,
  relPath: string,
  target: Target,
): Promise<SuiteResult> {
  const started = Date.now();
  const input = executeApiFlowInputSchema.parse({
    workspaceRoot,
    definitionRelativePath: relPath,
    responseDetail: "summary",
    stopOnError: true,
    ...(target.flowName
      ? { flowName: target.flowName }
      : { steps: [{ requestId: target.requestId }] }),
  });
  try {
    const result = await runApiFlow(input);
    return {
      name: target.suite,
      file: relPath,
      durationMs: Date.now() - started,
      cases: result.steps.map((s) => ({
        name: String(s.requestId),
        ok: Boolean(s.ok),
        status: typeof s.status === "number" ? s.status : undefined,
        durationMs: typeof s.durationMs === "number" ? s.durationMs : undefined,
        failure: s.ok
          ? undefined
          : `${String(s.errorPreview ?? "step failed")}${s.traceId ? `
trace ${String(s.traceId)}` : ""}`,
      })),
    };
  } catch (e) {
    return {
      name: target.suite,
      file: relPath,
      durationMs: Date.now() - started,
      cases: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Entry point of `run`; returns the process exit code (0 pass, 1 failures, 2 usage error). */
export async function runCli(argv: string[], io: RunCliIo = defaultIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        flow: { type: "string", multiple: true },
        request: { type: "string", multiple: true },
        "all-endpoints": { type: "boolean" },
        env: { type: "string" },
        reporter: { type: "string" },
        out: { type: "string" },
        workspace: { type: "string" },
        bail: { type: "boolean" },
        "update-snapshots": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n\n${RUN_USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(`${RUN_USAGE}\n`);
    return 0;
  }
  const reporter = values.reporter ?? "pretty";
  if (!["pretty", "junit", "json"].includes(reporter)) {
    io.stderr(`unknown reporter "${reporter}" (pretty, junit, json)\n`);
    return 2;
  }

  const workspaceRoot = resolve(values.workspace ?? process.cwd());
  const files = positionals.length
    ? positionals.map((p) => resolve(workspaceRoot, p))
    : (await glob("**/*.{yaml,yml}", { cwd: mcpApiDir(workspaceRoot), absolute: true }))
        .filter((f) => !/[\\/]_catalog\.ya?ml$/.test(f))
        .sort();
  if (!files.length) {
    io.stderr(`no definitions found under ${mcpApiDir(workspaceRoot)}\n`);
    return 2;
  }

  if (values["update-snapshots"]) {
    process.env.MCP_UPDATE_SNAPSHOTS = "1";
  }
  if (values.env) {
    setSessionVariable(workspaceRoot, "CURRENT_ENV", values.env.trim().toUpperCase());
  }

  const report: RunReport = { suites: [], skipped: [], startedAt: new Date().toISOString() };
  const opts = {
    flows: values.flow ?? [],
    requests: values.request ?? [],
    allEndpoints: values["all-endpoints"] ?? false,
  };

  outer: for (const file of files) {
    const relPath = relative(workspaceRoot, file).replaceAll("\\", "/");
    if (relPath.startsWith("..") || isAbsolute(relPath)) {
      report.skipped.push({ file, reason: "outside the workspace" });
      continue;
    }
    let def;
    try {
      def = readApiDefinitionFile(file);
    } catch (e) {
      report.suites.push({
        name: relPath,
        file: relPath,
        durationMs: 0,
        cases: [],
        error: `invalid definition: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    const targets = targetsFor(relPath, def, opts);
    if (typeof targets === "string") {
      report.skipped.push({ file: relPath, reason: targets });
      continue;
    }
    for (const target of targets) {
      const suite = await runTarget(workspaceRoot, relPath, target);
      report.suites.push(suite);
      const failed = suite.error !== undefined || suite.cases.some((c) => !c.ok);
      if (failed && values.bail) {
        break outer;
      }
    }
  }

  if (!report.suites.length) {
    io.stderr(
      `nothing to run:\n${report.skipped.map((s) => `  ${s.file}: ${s.reason}`).join("\n")}\n`,
    );
    return 2;
  }

  const text =
    reporter === "junit"
      ? renderJunit(report)
      : reporter === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderPretty(report);
  if (values.out) {
    const outPath = resolve(process.cwd(), values.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text);
    io.stdout(renderPretty(report, { summaryOnly: reporter !== "pretty" }));
    io.stdout(`report written to ${outPath}\n`);
  } else {
    io.stdout(text);
  }

  const failed = report.suites.some((s) => s.error !== undefined || s.cases.some((c) => !c.ok));
  return failed ? 1 : 0;
}
