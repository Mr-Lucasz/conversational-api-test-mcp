import { existsSync } from "node:fs";
import { mcpApiDir } from "./paths.js";

let lastWorkspaceRoot: string | undefined;

/**
 * Resolve `workspaceRoot` with fallback:
 * 1) explicit argument
 * 2) `process.env.MCP_WORKSPACE_ROOT`
 * 3) last workspaceRoot used in this session (process-local)
 * 4) the process cwd, only when it already holds `.mcp/api/` — clients that start
 *    the server from the project folder then never need to send the path, and a
 *    client that starts it from somewhere else does not get files written there.
 */
export function resolveWorkspaceRoot(workspaceRoot?: string): string {
  if (workspaceRoot) {
    lastWorkspaceRoot = workspaceRoot;
    return workspaceRoot;
  }

  const fromEnv = process.env.MCP_WORKSPACE_ROOT;
  if (fromEnv) {
    lastWorkspaceRoot = fromEnv;
    return fromEnv;
  }

  if (lastWorkspaceRoot) {
    return lastWorkspaceRoot;
  }

  const cwd = process.cwd();
  if (existsSync(mcpApiDir(cwd))) {
    lastWorkspaceRoot = cwd;
    return cwd;
  }

  throw new Error(
    "workspaceRoot was not provided and MCP_WORKSPACE_ROOT is not set for this process.",
  );
}
