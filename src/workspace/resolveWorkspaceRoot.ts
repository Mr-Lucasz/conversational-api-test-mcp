let lastWorkspaceRoot: string | undefined;

/**
 * Resolve `workspaceRoot` with fallback:
 * 1) explicit argument
 * 2) `process.env.MCP_WORKSPACE_ROOT`
 * 3) last workspaceRoot used in this session (process-local)
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

  throw new Error(
    "workspaceRoot was not provided and MCP_WORKSPACE_ROOT is not set for this process.",
  );
}

