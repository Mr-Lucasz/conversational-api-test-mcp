import { listApiDefinitionsHandler, listApiDefinitionsInputSchema } from "../tools/listApiDefinitions.js";
import { readApiDefinitionHandler, readApiDefinitionInputSchema } from "../tools/readApiDefinition.js";
import {
  upsertCanonicalApiDefinitionHandler,
  upsertCanonicalApiDefinitionInputSchema,
} from "../tools/upsertCanonicalApiDefinition.js";
import {
  reorganizeMcpApiDefinitionsHandler,
  reorganizeMcpApiDefinitionsInputSchema,
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
  executeApiFlowInputSchema,
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
} from "../tools/vanderChecks.js";
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
        "List YAML API definition files under `.mcp/api/` in the workspace. Optional `globPattern` (glob relative to `.mcp/api/`, default **/*.{yaml,yml}), `maxFiles`/`cursor` for pagination (returns `nextCursor` when truncated — pass it back to get the next page), `sortBy` path | mtime_asc | mtime_desc, `fields` to project `entries` items. Returns `totalMatched` and `truncated` when capped.",
      inputSchema: listApiDefinitionsInputSchema,
      handler: listApiDefinitionsHandler,
    },
    {
      name: "read_api_definition",
      description:
        "Read and validate a canonical API YAML (Zod). Path is relative to workspaceRoot.",
      inputSchema: readApiDefinitionInputSchema,
      handler: readApiDefinitionHandler,
    },
    {
      name: "upsert_canonical_api_definition",
      description:
        "Create or update a canonical YAML under `.mcp/api/` only. `mergeMode` replace_file (requires `replaceDefinition`) or append_endpoints (requires `appendEndpoints`). New file on append needs `createIfMissing`. Default `dryRun` true returns `preview` without writing; set `dryRun` false and `confirm` true to write (atomic replace + optional .bak backup). Endpoint ids must not collide on append.",
      inputSchema: upsertCanonicalApiDefinitionInputSchema,
      handler: upsertCanonicalApiDefinitionHandler,
    },
    {
      name: "reorganize_mcp_api_definitions",
      description:
        "Plan or apply merging multiple YAML definitions into fewer files. `mode` plan (no writes) or apply (requires `confirm` true). `groupBy` manual_groups (requires `manualGroups` with targetRelativePath + sourceGlobs relative to `.mcp/api/`) or same_service_field (auto groups files sharing non-empty `service` into `.mcp/api/_consolidated/*.yaml`). Conflicts (duplicate endpoint id across files, mismatched base_url/service/variables) block apply. Optional `deleteSourcesAfterMerge` or `moveSourcesToArchive` (mutually exclusive).",
      inputSchema: reorganizeMcpApiDefinitionsInputSchema,
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
        "Convert Postman / OpenAPI / Insomnia export to canonical YAML under `.mcp/api/`. Apidog: export as OpenAPI or Postman first.",
      inputSchema: convertLegacyToCanonicalInputSchema,
      handler: convertLegacyToCanonicalHandler,
    },
    {
      name: "execute_api_request",
      description:
        "Run one endpoint from canonical YAML: interpolate variables (YAML < .env.mcp.local < session; `{{env.NAME}}` reads process.env only for names in MCP_API_ENV_PASSTHROUGH). With session CURRENT_ENV from set_environment: {CURRENT_ENV}_KEY wins over generic KEY; unresolved placeholders stay literal {{KEY}} for visibility. Macros {{$uuid}}, {{$date:...}}, {{$timestamp}}; optional `form:` for OAuth; auth_dependency + capture + 401 retry; fetch; JSONPath capture; optional assert. Credential-looking values (captured tokens, sensitive JSON keys, auth headers) are returned as [REDACTED]; the real values stay in the session. Response: for JSON bodies, `bodyJson` is the parsed object when the payload is small enough; very large JSON returns a minimal wrapper with `topLevelKeys` plus truncated `bodyPreview`. Non-JSON (HTML, plain text) only has `bodyPreview`. `bodyPreviewTruncated` is true when the preview string was capped by length.",
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
        "Assert on the last HTTP response (status, jsonPathExists). Run after execute_api_request.",
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
        "Run a sequence of requestIds in a single MCP round trip. Pass inline `steps`, or `flowName` to run a flow declared under `flows:` in the definition. Each step supports retry, poll (via jsonPath), an inline assert (status/jsonPathExists, no extra round trip) and `optional`; `stopOnError` halts at the first failing required step.",
      inputSchema: executeApiFlowInputSchema,
      handler: executeApiFlowHandler,
    },
    {
      name: "dry_run_request",
      description:
        "Build the URL, method, headers and body preview for a requestId without sending the request. Credentials in headers, query string and body are redacted.",
      inputSchema: dryRunRequestInputSchema,
      handler: dryRunRequestHandler,
    },
    {
      name: "plan_vander_checks",
      description:
        "Build the VANDER checklist (Verbs, Authorization, Negative, Data, Errors, Responsiveness) for one requestId, derived deterministically from its definition. Sends nothing. Each check is `auto` (run_vander_checks can execute it; `destructive` marks state-changing probes) or `manual` (an idea to explore by hand).",
      inputSchema: planVanderChecksInputSchema,
      handler: planVanderChecksHandler,
    },
    {
      name: "run_vander_checks",
      description:
        "Execute the automatic VANDER checks for one requestId and return pass/fail/skipped grouped by axis. Probes vary method, credentials and body; they never capture variables or replace the session's last response. State-changing probes (any POST/PUT/PATCH/DELETE) are skipped unless `includeDestructive` is true — ask the user before enabling it. `maxDurationMs` is the budget for the Responsiveness check.",
      inputSchema: runVanderChecksInputSchema,
      handler: runVanderChecksHandler,
    },
  ];
}
