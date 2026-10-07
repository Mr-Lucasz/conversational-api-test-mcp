import { normalize, relative, resolve, sep } from "node:path";

export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

/**
 * Resolve workspace-relative path and block path traversal.
 */
export function safeResolveUnderWorkspace(
  workspaceRoot: string,
  relativePath: string,
): string {
  if (relativePath.includes("..") || relativePath.includes("~")) {
    throw new Error(`Invalid path: ${relativePath}`);
  }
  const root = resolve(normalize(workspaceRoot));
  const joined = resolve(root, normalize(relativePath));
  if (!isInsideRoot(root, joined)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return joined;
}

export function mcpApiDir(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".mcp", "api");
}

/**
 * Resolve a workspace-relative YAML path that must live under `.mcp/api/`
 * (used by write/merge tools; blocks traversal and paths outside API defs).
 */
export function safeResolveMcpApiYaml(
  workspaceRoot: string,
  relativePath: string,
): string {
  const full = safeResolveUnderWorkspace(workspaceRoot, relativePath);
  const apiRoot = mcpApiDir(workspaceRoot);
  if (!isInsideRoot(apiRoot, full)) {
    throw new Error(
      `API definition path must stay under .mcp/api: ${relativePath}`,
    );
  }
  const lower = relativePath.toLowerCase();
  if (!lower.endsWith(".yaml") && !lower.endsWith(".yml")) {
    throw new Error(
      `API definition must use extension .yaml or .yml: ${relativePath}`,
    );
  }
  return full;
}
