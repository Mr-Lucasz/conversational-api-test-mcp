#!/usr/bin/env node
import { runMcpStdio } from "./runMcpStdio.js";

// `conversational-api-test-mcp run …` runs flows from the terminal / CI and
// `… mock …` serves the definitions as a mock API; with no subcommand the
// process is the MCP server on stdio, as before.
const command = process.argv[2];
if (command === "run") {
  const { runCli } = await import("./cli/run.js");
  process.exitCode = await runCli(process.argv.slice(3));
} else if (command === "mock") {
  const { runMockCli } = await import("./cli/mock.js");
  const { code, server } = await runMockCli(process.argv.slice(3), {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  });
  if (!server) process.exitCode = code;
} else {
  await runMcpStdio();
}
