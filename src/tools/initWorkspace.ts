import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ENV_FILE_NAME, isEnvFileGitIgnored } from "../vander/onboarding.js";
import { mcpApiDir } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import { safeTool, textResult } from "./toolResult.js";

const DEMO_FILE = "demo.yaml";

const ENV_TEMPLATE = [
  "# Secrets and per-environment values for conversational-api-test-mcp.",
  "# Fill this in yourself. Never commit it and never paste these values into a chat.",
  "#",
  "# KEY=value here is what {{KEY}} resolves to in .mcp/api/*.yaml.",
  "# With a prefix, the same YAML runs against another environment:",
  '# after "use staging", {{BASE_URL}} reads STAGING_BASE_URL first, then BASE_URL.',
  "#",
  "# BASE_URL=https://api.example.com",
  "# API_TOKEN=",
  "# STAGING_BASE_URL=https://staging.example.com",
  "",
].join("\n");

export const initWorkspaceInputSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe("Absolute project path (optional when MCP_WORKSPACE_ROOT is set)."),
  withDemo: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Also write `.mcp/api/demo.yaml`, a runnable definition against httpbin.org, when the folder has no definition yet.",
    ),
});

function demoDefinition(): string {
  return readFileSync(
    new URL("../../examples/httpbin.example.yaml", import.meta.url),
    "utf8",
  );
}

export async function initWorkspaceHandler(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = initWorkspaceInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }
  return safeTool(async () => {
    const root = resolve(resolveWorkspaceRoot(parsed.data.workspaceRoot));
    if (!existsSync(root)) {
      throw new Error(`workspaceRoot does not exist: ${root}`);
    }
    const created: string[] = [];
    const kept: string[] = [];

    const apiDir = mcpApiDir(root);
    if (existsSync(apiDir)) {
      kept.push(".mcp/api/");
    } else {
      mkdirSync(apiDir, { recursive: true });
      created.push(".mcp/api/");
    }

    const demoPath = join(apiDir, DEMO_FILE);
    const hasDefinitions = readdirSync(apiDir, { recursive: true }).some((f) =>
      /\.ya?ml$/i.test(String(f)),
    );
    if (parsed.data.withDemo && !hasDefinitions && !existsSync(demoPath)) {
      writeFileSync(demoPath, demoDefinition(), "utf8");
      created.push(`.mcp/api/${DEMO_FILE}`);
    }

    const envPath = join(root, ENV_FILE_NAME);
    if (existsSync(envPath)) {
      kept.push(ENV_FILE_NAME);
    } else {
      writeFileSync(envPath, ENV_TEMPLATE, "utf8");
      created.push(ENV_FILE_NAME);
    }

    if (isEnvFileGitIgnored(root)) {
      kept.push(`.gitignore (already lists ${ENV_FILE_NAME})`);
    } else {
      const gitignore = join(root, ".gitignore");
      const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
      appendFileSync(
        gitignore,
        `${existing && !existing.endsWith("\n") ? "\n" : ""}${ENV_FILE_NAME}\n`,
        "utf8",
      );
      created.push(`.gitignore (added ${ENV_FILE_NAME})`);
    }

    return {
      created,
      kept,
      nextSteps: [
        ...(created.includes(`.mcp/api/${DEMO_FILE}`)
          ? [
              `Try it now: run_vander_checks or execute_api_request on ".mcp/api/${DEMO_FILE}", requestId "whoami" (public demo API, no secrets needed).`,
            ]
          : []),
        `The user fills ${ENV_FILE_NAME} in their editor with their own base URLs and tokens — do not ask for those values in chat.`,
        "Then describe their API in a new YAML under .mcp/api/ (upsert_canonical_api_definition), or convert an existing Postman / OpenAPI / Insomnia file.",
      ],
    };
  });
}
