import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { glob } from "tinyglobby";
import { readApiDefinitionFile } from "../canonical/io.js";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import { discoverLegacyApiSources, type LegacyHit } from "../workspace/discovery.js";
import { mcpApiDir } from "../workspace/paths.js";

export const ENV_FILE_NAME = ".env.mcp.local";

const MAX_DEFINITIONS_READ = 20;
const MAX_LISTED = 6;
const ENV_KEY = /^([A-Z][A-Z0-9]*)_(BASE_URL|URL|HOST)$/;

export type WorkspaceSnapshot = {
  totalDefinitions: number;
  definitions: Array<{
    path: string;
    service?: string;
    endpoints: number;
    flows: string[];
    invalid?: boolean;
  }>;
  importable: LegacyHit[];
  envFileExists: boolean;
  envFileIgnored: boolean;
  environments: string[];
};

export function isEnvFileGitIgnored(root: string): boolean {
  const gitignore = join(root, ".gitignore");
  return (
    existsSync(gitignore) &&
    readFileSync(gitignore, "utf8")
      .split(/\r?\n/)
      .some((l) => l.trim().replace(/^\//, "") === ENV_FILE_NAME)
  );
}

/** Which of the setup pieces already exist in the workspace. Sends nothing. */
export async function snapshotWorkspace(
  workspaceRoot: string,
): Promise<WorkspaceSnapshot> {
  const root = resolve(workspaceRoot);
  const files = (
    await glob("**/*.{yaml,yml}", {
      cwd: mcpApiDir(root),
      onlyFiles: true,
      absolute: true,
      ignore: ["**/node_modules/**", "**/_archive/**", "**/_catalog.*"],
    })
  ).sort();

  const definitions = files.slice(0, MAX_DEFINITIONS_READ).map((abs) => {
    const path = relative(root, abs).replace(/\\/g, "/");
    try {
      const def = readApiDefinitionFile(abs);
      return {
        path,
        service: def.service ?? def.name,
        endpoints: def.endpoints.length,
        flows: Object.keys(def.flows ?? {}),
      };
    } catch {
      return { path, endpoints: 0, flows: [], invalid: true };
    }
  });

  const environments = [
    ...new Set(
      Object.keys(loadEnvMcpLocalParsed(root))
        .map((k) => ENV_KEY.exec(k)?.[1])
        .filter((e): e is string => Boolean(e)),
    ),
  ].sort();

  return {
    totalDefinitions: files.length,
    definitions,
    importable: await discoverLegacyApiSources({
      workspaceRoot: root,
      maxFiles: 20,
    }),
    envFileExists: existsSync(join(root, ENV_FILE_NAME)),
    envFileIgnored: isEnvFileGitIgnored(root),
    environments,
  };
}

function renderChecklist(s: WorkspaceSnapshot): string[] {
  const mark = (done: boolean) => (done ? "[done]" : "[missing]");
  const lines = [
    "Setup status of this workspace (facts — do not invent beyond them):",
    `- ${mark(s.totalDefinitions > 0)} definitions in \`.mcp/api/\`${s.totalDefinitions ? `: ${s.totalDefinitions}` : ""}`,
  ];
  for (const d of s.definitions.slice(0, MAX_LISTED)) {
    lines.push(
      d.invalid
        ? `  - ${d.path} (does not validate — offer to look at it)`
        : `  - ${d.path}: ${d.service ? `service "${d.service}", ` : ""}${d.endpoints} requests${d.flows.length ? `, flows: ${d.flows.join(", ")}` : ", no flows"}`,
    );
  }
  if (s.totalDefinitions > MAX_LISTED) {
    lines.push(`  - … and ${s.totalDefinitions - MAX_LISTED} more`);
  }
  lines.push(
    `- ${mark(s.envFileExists)} \`${ENV_FILE_NAME}\` at the project root${s.environments.length ? ` (environments: ${s.environments.join(", ")})` : ""}`,
    `- ${mark(s.envFileIgnored)} \`${ENV_FILE_NAME}\` listed in \`.gitignore\``,
  );
  if (s.importable.length) {
    lines.push(
      `- importable files found: ${s.importable
        .slice(0, MAX_LISTED)
        .map((h) => `${h.relativePath} (${h.hint})`)
        .join("; ")}${s.importable.length > MAX_LISTED ? `; … ${s.importable.length - MAX_LISTED} more` : ""}`,
    );
  }
  return lines;
}

const EXPLAIN = [
  "First contact — onboarding. Assume the user has never used this server. In their language and in your own words, walk them through the four parts below. Keep it to about one screen: short paragraphs, the two snippets, a short list. Then ask what they are testing today.",
  "",
  "Part 1 — What this is.",
  "API testing by conversation. The user describes their API once in a YAML file kept in the repository; from then on they ask in plain language (\"run the login and list the orders on staging\") and you send the real requests and report what came back. For someone coming from Postman: the YAML is the collection, the `.env.mcp.local` file is the environment, and the chat replaces clicking Send and reading the Tests tab.",
  "",
  "Part 2 — How it works: three pieces.",
  "1. `.mcp/api/` — a folder at the project root holding one YAML per service. Each YAML lists requests, each with an `id` you call it by. It is safe to commit. Minimal example to show:",
  "```yaml",
  "# .mcp/api/my-api.yaml",
  'version: "1"',
  'base_url: "{{BASE_URL}}"',
  "endpoints:",
  "  - id: get_user",
  "    method: GET",
  "    path: /users/1",
  "    auth: Bearer {{API_TOKEN}}",
  "```",
  "   They do not have to write that YAML by hand. Say so explicitly: they can paste a cURL command, paste a whole Postman collection (the exported JSON) or an OpenAPI / Insomnia file, or point at such a file in the repo, and you create the YAML for them. Any token that comes along is moved to `.env.mcp.local` automatically.",
  "2. `.env.mcp.local` — a file at the project root with the values behind `{{...}}`: base URLs, tokens, passwords. The user creates and fills it in their editor. It must be git-ignored and its values must never be pasted into the chat. Example to show:",
  "```dotenv",
  "# .env.mcp.local",
  "BASE_URL=https://api.example.com",
  "API_TOKEN=put-your-token-here",
  "STAGING_BASE_URL=https://staging.example.com",
  "```",
  "   With a `STAGING_` prefix the same YAML runs against another environment once they say \"use staging\".",
  "3. The conversation — they ask, you call this server's tools. They never need to know tool names.",
  "",
  "Part 3 — Where they stand. Use the setup status below. Say what is already in place and what is missing. If something is missing, offer to create it with `init_workspace` (it adds a runnable demo definition, an `.env.mcp.local` template and the `.gitignore` line, and never overwrites anything); if importable files were found, offer to convert them instead of starting from the demo. Either way, remind them that pasting a cURL or a collection is the fastest start.",
  "",
  "Part 4 — What they can ask. Give four or five examples as sentences they can copy, picked from the list at the end and naming real files, requests or flows from the setup status when there are any.",
];

const USE_CASES = [
  "Things people ask for (Postman term → what to call here):",
  '- "Here is my collection" (Import), pasted as JSON or as a file in the repo → `convert_legacy_to_canonical` with `legacyContent` (pasted text) or `legacyRelativePath` (file; find candidates with `discover_legacy_api_sources`). Works for Postman collections, OpenAPI/Swagger and Insomnia exports.',
  '- "Here is a cURL" (Import → Raw text) → `import_curl`: pick a short `requestId`, pass the command untouched.',
  '- "Send this request" (Send) → `execute_api_request` with a `requestId`.',
  '- "Run the collection" / "run the smoke tests" (Collection Runner) → `execute_api_flow` with a `flowName`, or inline `steps`.',
  '- "Log in, then call the API" (pre-request script that fetches a token) → `auth_dependency` + `capture` on the login request; it reruns on a 401.',
  '- "Use the id from the last response in the next request" (`pm.environment.set` in the Tests tab) → `capture` plus `{{variable}}`.',
  '- "Point it at staging" (environment dropdown) → `set_environment`; values come from `STAGING_*` keys in `.env.mcp.local`.',
  '- "Check it returns 200 and has a field" (Tests tab, `pm.test`) → `assert` on the request or the flow step, or `assert_response`.',
  '- "Wait until the job finishes" (`setNextRequest` loop) → a flow step with `poll`.',
  '- "Show me what would be sent" (Console / code snippet) → `dry_run_request`.',
  '- "Add a request that does X" (New Request), described in words → `upsert_canonical_api_definition`, dry-run first, write only after the user agrees.',
  '- "Test my chatbot / RAG / search" (no Postman equivalent: the answer changes every time) → `run_eval` with cases, `repeat` and a pass rate; `judge` for what only a reader can grade.',
  '- "Is this endpoint solid?" (no Postman equivalent) → `plan_vander_checks` and `run_vander_checks`.',
];

const RETURNING = [
  "This workspace is already set up — skip the product tour. In the user's language: say in a line or two what is in place (setup status below), give three or four requests they can copy, naming real files, requests or flows from it, and ask what they are testing today.",
  "Only if they ask how it works: the YAML in `.mcp/api/` is the collection, `.env.mcp.local` is the environment (never pasted into the chat), and the conversation replaces Send and the Tests tab. New requests can come from a pasted cURL (`import_curl`) or a Postman / OpenAPI / Insomnia export (`convert_legacy_to_canonical`).",
];

/**
 * First-contact brief: what the product is, how it works, what is set up, what to ask.
 * A workspace with all three pieces in place gets the short version — the tour is
 * most of the text and tells that user nothing new.
 */
export function renderOnboarding(snapshot: WorkspaceSnapshot | null): string {
  if (
    snapshot &&
    snapshot.totalDefinitions > 0 &&
    snapshot.envFileExists &&
    snapshot.envFileIgnored
  ) {
    return [...RETURNING, "", ...renderChecklist(snapshot)].join("\n");
  }
  const status = snapshot
    ? renderChecklist(snapshot)
    : [
        "Setup status: unknown. Call `summon_vander` again with `workspaceRoot` set to the absolute project path to get it.",
      ];
  return [...EXPLAIN, "", ...status, "", ...USE_CASES].join("\n");
}
