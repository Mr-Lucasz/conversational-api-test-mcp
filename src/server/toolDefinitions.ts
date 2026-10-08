import { listApiDefinitionsHandler, listApiDefinitionsInputSchema } from "../tools/listApiDefinitions.js";
import { readApiDefinitionHandler, readApiDefinitionInputSchema } from "../tools/readApiDefinition.js";
import {
  upsertCanonicalApiDefinitionHandler,
  upsertCanonicalApiDefinitionToolSchema,
} from "../tools/upsertCanonicalApiDefinition.js";
import {
  reorganizeMcpApiDefinitionsHandler,
  reorganizeMcpApiDefinitionsToolSchema,
} from "../tools/reorganizeMcpApiDefinitions.js";
import {
  discoverLegacySourcesHandler,
  discoverLegacySourcesInputSchema,
} from "../tools/discoverLegacySources.js";
import {
  convertLegacyToCanonicalHandler,
  convertLegacyToCanonicalInputSchema,
} from "../tools/convertLegacyToCanonical.js";
import {
  executeApiRequestHandler,
  executeApiRequestInputSchema,
} from "../tools/executeApiRequest.js";
import {
  getEnvironmentVariableHandler,
  getEnvironmentVariableInputSchema,
} from "../tools/getEnvironmentVariable.js";
import {
  setEnvironmentVariableHandler,
  setEnvironmentVariableInputSchema,
} from "../tools/setEnvironmentVariable.js";
import {
  setEnvironmentHandler,
  setEnvironmentInputSchema,
} from "../tools/setEnvironment.js";
import {
  assertResponseHandler,
  assertResponseInputSchema,
} from "../tools/assertResponseTool.js";
import {
  explainRequestContextHandler,
  explainRequestContextInputSchema,
} from "../tools/explainRequestContext.js";
import {
  summarizeApiDefinitionHandler,
  summarizeApiDefinitionInputSchema,
} from "../tools/summarizeApiDefinition.js";
import {
  executeApiFlowHandler,
  executeApiFlowToolSchema,
} from "../tools/executeApiFlow.js";
import {
  dryRunRequestHandler,
  dryRunRequestInputSchema,
} from "../tools/dryRunRequest.js";
import {
  planVanderChecksHandler,
  planVanderChecksInputSchema,
  runVanderChecksHandler,
  runVanderChecksInputSchema,
  summonVanderHandler,
  summonVanderInputSchema,
} from "../tools/vanderChecks.js";
import {
  initWorkspaceHandler,
  initWorkspaceInputSchema,
} from "../tools/initWorkspace.js";
import { importCurlHandler, importCurlInputSchema } from "../tools/importCurl.js";
import { runEvalHandler, runEvalInputSchema } from "../tools/runEval.js";
import type { z } from "zod";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Record<string, unknown>>;
  handler: (args: unknown) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
};

export function getAllToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_api_definitions",
      description:
        "List YAML API definition files under `.mcp/api/`. Returns `files` (paths), or `entries` (path/service/summary) with `includeCatalogMeta` or `query`; plus `totalMatched`, `truncated` and, when capped by `maxFiles`, a `nextCursor` to pass back as `cursor`.",
      inputSchema: listApiDefinitionsInputSchema,
      handler: listApiDefinitionsHandler,
    },
    {
      name: "read_api_definition",
      description:
        "Read and validate a whole API YAML definition. Prefer summarize_api_definition for triage.",
      inputSchema: readApiDefinitionInputSchema,
      handler: readApiDefinitionHandler,
    },
    {
      name: "upsert_canonical_api_definition",
      description:
        "Create or update a canonical YAML under `.mcp/api/` only. `mergeMode` replace_file (requires `replaceDefinition`) or append_endpoints (requires `appendEndpoints`). New file on append needs `createIfMissing`. Default `dryRun` true returns `preview` without writing; set `dryRun` false and `confirm` true to write (atomic replace + optional .bak backup). Endpoint ids must not collide on append.",
      inputSchema: upsertCanonicalApiDefinitionToolSchema,
      handler: upsertCanonicalApiDefinitionHandler,
    },
    {
      name: "reorganize_mcp_api_definitions",
      description:
        "Plan or apply merging multiple YAML definitions into fewer files. `mode` plan (no writes) or apply (requires `confirm` true). `groupBy` manual_groups (requires `manualGroups` with targetRelativePath + sourceGlobs relative to `.mcp/api/`) or same_service_field (auto groups files sharing non-empty `service` into `.mcp/api/_consolidated/*.yaml`). Conflicts (duplicate endpoint id across files, mismatched base_url/service/variables) block apply. Optional `deleteSourcesAfterMerge` or `moveSourcesToArchive` (mutually exclusive).",
      inputSchema: reorganizeMcpApiDefinitionsToolSchema,
      handler: reorganizeMcpApiDefinitionsHandler,
    },
    {
      name: "discover_legacy_api_sources",
      description:
        "Find Postman collections, OpenAPI/Swagger, or Insomnia exports.",
      inputSchema: discoverLegacySourcesInputSchema,
      handler: discoverLegacySourcesHandler,
    },
    {
      name: "convert_legacy_to_canonical",
      description:
        "Turn a Postman collection, an OpenAPI/Swagger spec or an Insomnia export into a YAML definition under `.mcp/api/`. Give `legacyRelativePath` for a file in the workspace, or `legacyContent` with the JSON/YAML text the user pasted. Literal credentials found in headers or auth are moved to `.env.mcp.local` and replaced by `{{VARIABLE}}`. Refuses to replace an existing file unless `overwrite` is true. Apidog: export as OpenAPI or Postman first.",
      inputSchema: convertLegacyToCanonicalInputSchema,
      handler: convertLegacyToCanonicalHandler,
    },
    {
      name: "import_curl",
      description:
        "Turn a `curl` command the user pasted into a request in a YAML definition under `.mcp/api/` (creates the file, or appends to it). Method, URL, query string, headers and JSON / form body are carried over. Credentials (Authorization, cookies, `-u`, credential-looking fields) are moved to `.env.mcp.local` and replaced by `{{VARIABLE}}`, so the YAML stays safe to commit. Fails if `requestId` already exists.",
      inputSchema: importCurlInputSchema,
      handler: importCurlHandler,
    },
    {
      name: "execute_api_request",
      description:
        "Send one request from a YAML definition. Variables resolve YAML < .env.mcp.local < session (after set_environment, {ENV}_KEY wins over KEY); an unresolved placeholder is sent as the literal {{KEY}}. Runs `auth_dependency` first when needed, retries once on 401, applies `capture` and `assert`. The body comes back once: `bodyJson` for JSON that fits the cap, `bodyPreview` for text; JSON over the cap gives a truncated `bodyPreview` plus `bodyJson.topLevelKeys` — narrow it with `jsonPathSelect`. `responseDetail`: minimal = status only; summary = body (8k chars) and the headers that matter; full = every header, 50k chars.",
      inputSchema: executeApiRequestInputSchema,
      handler: executeApiRequestHandler,
    },
    {
      name: "get_environment_variable",
      description: "Read a session variable set by capture or set_environment_variable. Credential-looking values come back as [REDACTED] with `masked: true`.",
      inputSchema: getEnvironmentVariableInputSchema,
      handler: getEnvironmentVariableHandler,
    },
    {
      name: "set_environment_variable",
      description: "Set a session variable for subsequent requests.",
      inputSchema: setEnvironmentVariableInputSchema,
      handler: setEnvironmentVariableHandler,
    },
    {
      name: "set_environment",
      description:
        "Set the active logical environment for this workspace session (session CURRENT_ENV, e.g. STAGING). Interpolation resolves {CURRENT_ENV}_VAR from .env.mcp.local before generic VAR (prefix-first). Put all env secrets there (DEVELOP_*, STAGING_*); YAML stays generic.",
      inputSchema: setEnvironmentInputSchema,
      handler: setEnvironmentHandler,
    },
    {
      name: "assert_response",
      description:
        "Assert on the last HTTP response: status, jsonPathExists, maxDurationMs and value `checks` (contains, regex, equality, ranges, list membership). Reports every check that failed. Run after execute_api_request.",
      inputSchema: assertResponseInputSchema,
      handler: assertResponseHandler,
    },
    {
      name: "explain_request_context",
      description:
        "Summarize YAML keys, .env.mcp.local keys, session keys, and optional endpoint snippet.",
      inputSchema: explainRequestContextInputSchema,
      handler: explainRequestContextHandler,
    },
    {
      name: "summarize_api_definition",
      description:
        "Summarize a canonical API YAML without returning the full definition. Use names_only for triage (optionally with `fields` to trim endpoint entries); use full only when needed.",
      inputSchema: summarizeApiDefinitionInputSchema,
      handler: summarizeApiDefinitionHandler,
    },
    {
      name: "execute_api_flow",
      description:
        "Run a sequence of requestIds in a single MCP round trip. Pass inline `steps`, or `flowName` to run a flow declared under `flows:` in the definition. Each step supports retry, poll (via jsonPath), an inline `assert` (same shape as assert_response), `optional`, and `jsonPathSelect` to get that step's body back (`$` for all of it) without a follow-up call. `stopOnError` halts at the first failing required step.",
      inputSchema: executeApiFlowToolSchema,
      handler: executeApiFlowHandler,
    },
    {
      name: "run_eval",
      description:
        "Evaluate an endpoint whose answer varies (LLM / RAG / search) — or any endpoint over many inputs — in one call. Runs each case `repeat` times and passes it when `passRate` of the runs satisfy `expect`; returns one row per case, the distinct failures, latency p50/p95 and how many different answers came back. With `judge` it also returns question / answer / retrieved passages for you to grade what code cannot (faithfulness, relevance). Runs do not capture variables or replace the session's last response. Every run is a real, possibly paid, request.",
      inputSchema: runEvalInputSchema,
      handler: runEvalHandler,
    },
    {
      name: "dry_run_request",
      description:
        "Build the URL, method, headers and body preview for a requestId without sending the request. Credentials in headers, query string and body are redacted.",
      inputSchema: dryRunRequestInputSchema,
      handler: dryRunRequestHandler,
    },
    {
      name: "summon_vander",
      description:
        "Call this whenever the user addresses Vander by name (\"hi Vander\", \"oi Vander\", \"Vander, review X\") or asks for a VANDER review. Pass `workspaceRoot`. Returns the Vander persona brief and, when no endpoint was named, an onboarding: what this server is, the three pieces it needs (`.mcp/api/` YAML, `.env.mcp.local`, the conversation), which of them this workspace already has, and what the user can ask for. Adopt the persona for the rest of the conversation and follow its working method. Sends no HTTP request.",
      inputSchema: summonVanderInputSchema,
      handler: summonVanderHandler,
    },
    {
      name: "init_workspace",
      description:
        "Create the starting structure in a project: the `.mcp/api/` folder, a runnable demo definition (`demo.yaml`, against httpbin.org) when there is no definition yet, an `.env.mcp.local` template with commented examples, and the `.gitignore` line that keeps that file out of git. Never overwrites an existing file. Ask the user before calling it.",
      inputSchema: initWorkspaceInputSchema,
      handler: initWorkspaceHandler,
    },
    {
      name: "plan_vander_checks",
      description:
        "Build the VANDER checklist (Verbs, Authorization, Negative, Data, Errors, Responsiveness) for one requestId, derived deterministically from its definition. Sends nothing. The id prefix is the axis (`V-`, `A-`, …). `mode`: `auto` (run_vander_checks executes it), `destructive` (auto, but state-changing) or `manual` (an idea to explore by hand).",
      inputSchema: planVanderChecksInputSchema,
      handler: planVanderChecksHandler,
    },
    {
      name: "run_vander_checks",
      description:
        "Execute the automatic VANDER checks for one requestId. Returns one row per check (`id`, whose prefix is the axis; `result` pass/fail/skipped; `detail` with the evidence) and `failures` with expected/actual/body snippet. Probes vary method, credentials and body; they never capture variables or replace the session's last response. State-changing probes (any POST/PUT/PATCH/DELETE) are skipped unless `includeDestructive` is true — ask the user before enabling it. `maxDurationMs` is the budget for the Responsiveness check.",
      inputSchema: runVanderChecksInputSchema,
      handler: runVanderChecksHandler,
    },
  ];
}
