import { glob } from "tinyglobby";
import { relative, resolve } from "node:path";

export type DiscoverOptions = {
  workspaceRoot: string;
  maxFiles?: number;
  maxDepth?: number;
};

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
];

const LEGACY_PATTERNS = [
  "**/collection*.json",
  "**/*postman*.json",
  "**/swagger*.yml",
  "**/swagger*.yaml",
  "**/openapi*.yml",
  "**/openapi*.yaml",
  "**/openapi*.json",
  "**/insomnia*.json",
  "**/insomnia*.yaml",
];

export type LegacyHit = {
  relativePath: string;
  hint: string;
};

function hintForPath(p: string): string {
  const lower = p.toLowerCase();
  if (lower.includes("swagger") || lower.includes("openapi")) {
    return "openapi";
  }
  if (lower.includes("insomnia")) {
    return "insomnia";
  }
  if (lower.includes("collection") || lower.includes("postman")) {
    return "postman";
  }
  return "unknown";
}

export async function discoverLegacyApiSources(
  options: DiscoverOptions,
): Promise<LegacyHit[]> {
  const root = resolve(options.workspaceRoot);
  const maxFiles = options.maxFiles ?? 200;
  const depth = options.maxDepth ?? 12;

  const entries = await glob(LEGACY_PATTERNS, {
    cwd: root,
    dot: false,
    absolute: true,
    onlyFiles: true,
    ignore: DEFAULT_IGNORE,
    deep: depth,
  });

  const hits: LegacyHit[] = [];
  for (const abs of entries.slice(0, maxFiles)) {
    hits.push({
      relativePath: relative(root, abs).replace(/\\/g, "/"),
      hint: hintForPath(abs),
    });
  }
  return hits;
}
