import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as dotenvParse } from "dotenv";

const ENV_FILE = ".env.mcp.local";

/** Cache por caminho absoluto, invalidada por `mtimeMs` — evita reler/reparsear a cada request. */
const envCache = new Map<
  string,
  { mtimeMs: number; vars: Record<string, string> }
>();

/**
 * Load `.env.mcp.local` from workspace root without mutating process.env
 * (parse-only). Falls back to empty object if missing.
 */
export function loadEnvMcpLocalParsed(
  workspaceRoot: string,
): Record<string, string> {
  const path = resolve(join(workspaceRoot, ENV_FILE));
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const cached = envCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.vars;
    }
    const raw = readFileSync(path, "utf8");
    const parsed = dotenvParse(raw);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== undefined) {
        out[k] = String(v);
      }
    }
    envCache.set(path, { mtimeMs, vars: out });
    return out;
  } catch {
    return {};
  }
}
