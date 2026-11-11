#!/usr/bin/env node
import { runMcpStdio } from "./runMcpStdio.js";

// `conversational-api-test-mcp run …` runs flows from the terminal / CI;
// with no subcommand the process is the MCP server on stdio, as before.
if (process.argv[2] === "run") {
  const { runCli } = await import("./cli/run.js");
  process.exitCode = await runCli(process.argv.slice(3));
} else {
  await runMcpStdio();
}
