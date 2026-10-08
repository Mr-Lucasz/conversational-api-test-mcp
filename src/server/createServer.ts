import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllToolDefinitions } from "./toolDefinitions.js";
import { getAllResources } from "../resources/index.js";
import { getAllPrompts } from "../prompts/index.js";

const SERVER_INSTRUCTIONS = [
  "Prefer responseDetail \"minimal\" or \"summary\" in execute_api_request/execute_api_flow; ask for \"full\" only when you need the whole body/headers.",
  "Use jsonPathSelect to project the body before raising maxBodyChars.",
  "For request sequences use execute_api_flow (one tool call, with retry/poll/assert per step; `flowName` runs a flow declared in the YAML) instead of several execute_api_request calls; put jsonPathSelect on the step whose body you need.",
  "workspaceRoot is remembered: pass it on the first call and omit it afterwards.",
  "To discover definitions: list_api_definitions -> summarize_api_definition (detailLevel \"names_only\") -> read_api_definition only when you need the full file.",
  "Credential-looking values are returned as [REDACTED]; they are still stored in the session and used by later requests, so never ask the user to paste them.",
  "This server ships a persona named Vander, a senior API QA engineer. When the user addresses Vander by name or asks for a VANDER review, call summon_vander first and answer as Vander from then on; otherwise answer as yourself.",
  "For a structured review of an endpoint use run_vander_checks (VANDER heuristic: Verbs, Authorization, Negative, Data, Errors, Responsiveness).",
  "For an endpoint whose answer varies (LLM, RAG, search) use run_eval: cases, repeats and a pass rate are checked by code; anything you grade yourself from its `judge` samples must be reported as your judgement, apart from the code-verified results.",
  "Tool responses are TOON (Token-Oriented Object Notation), not JSON: \"key: value\" per line, and uniform arrays as \"name[N]{col1,col2}:\" followed by CSV rows — same data as the equivalent JSON, just more compact. Read it as-is; do not JSON.parse the response text.",
].join(" ");

const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

export function createConversationalApiMcpServer(): McpServer {
  const server = new McpServer(
    { name: "conversational-api-test-mcp", version: PACKAGE_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  for (const tool of getAllToolDefinitions()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown) => {
        const result = await tool.handler(args ?? {});
        return {
          content: result.content,
          ...(result.isError !== undefined && { isError: result.isError }),
        };
      },
    );
  }

  for (const res of getAllResources()) {
    const uri = res.uri;
    server.registerResource(
      res.name ?? res.uri,
      uri,
      { mimeType: res.mimeType },
      async () => ({
        contents: [{ uri, mimeType: res.mimeType, text: res.content }],
      }),
    );
  }

  for (const prompt of getAllPrompts()) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: prompt.argsSchema,
      },
      (args) => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: prompt.build(args) },
          },
        ],
      }),
    );
  }

  return server;
}
