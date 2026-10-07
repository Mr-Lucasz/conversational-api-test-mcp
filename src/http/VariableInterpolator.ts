import { randomUUID } from "node:crypto";

export type InterpolationContext = Record<string, string>;

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Max nesting for `{{var}}` whose value contains more placeholders. */
const MAX_INTERPOLATION_DEPTH = 10;

/** Session / reserved key for prefix resolution — do not chain-prefix. */
const CURRENT_ENV_KEY = "CURRENT_ENV";

/**
 * Keys whose values came from the session (captures / set_environment_variable).
 * Those are data, not templates: they are substituted literally and never
 * re-expanded, so a response containing `{{SECRET}}` cannot pull a secret in.
 */
const literalKeysByContext = new WeakMap<InterpolationContext, Set<string>>();

/** When nothing resolves, return this so callers (and LLMs) see a missing binding. */
function unresolvedPlaceholder(trimmedKey: string): string {
  return `{{${trimmedKey}}}`;
}

function isNonEmpty(v: string | undefined): v is string {
  return v !== undefined && v !== "";
}

/**
 * `{{env.NAME}}` reads `process.env` only for names listed in
 * `MCP_API_ENV_PASSTHROUGH` (comma-separated; a trailing `*` matches a prefix).
 * Nothing is exposed by default — put secrets in `.env.mcp.local`.
 */
function isProcessEnvExposed(name: string): boolean {
  const raw = process.env.MCP_API_ENV_PASSTHROUGH?.trim();
  if (!raw) {
    return false;
  }
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) =>
      p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p,
    );
}

function lookup(
  key: string,
  ctx: InterpolationContext,
): { value: string; literal: boolean } | undefined {
  const literalKeys = literalKeysByContext.get(ctx);
  const hit = (k: string) => {
    const v = ctx[k];
    return isNonEmpty(v)
      ? { value: v, literal: literalKeys?.has(k) ?? false }
      : undefined;
  };

  if (key === CURRENT_ENV_KEY) {
    return hit(key);
  }

  if (key.startsWith("env.")) {
    const envName = key.slice("env.".length);
    const v = isProcessEnvExposed(envName) ? process.env[envName] : undefined;
    return isNonEmpty(v) ? { value: v, literal: true } : undefined;
  }

  const rawEnv = ctx[CURRENT_ENV_KEY]?.trim();
  if (rawEnv) {
    const prefixed = hit(`${rawEnv.toUpperCase()}_${key}`);
    if (prefixed) {
      return prefixed;
    }
  }

  return hit(key);
}

/**
 * Profile-style resolution: when `CURRENT_ENV` is set in context,
 * **`{ENV}_{KEY}` first**, then generic `KEY`. Empty string counts as unset (fallback).
 * If still missing, returns the literal `{{KEY}}` (not silent empty string).
 */
export function resolveContextValue(
  key: string,
  ctx: InterpolationContext,
): string {
  const trimmed = key.trim();
  return lookup(trimmed, ctx)?.value ?? unresolvedPlaceholder(trimmed);
}

/**
 * Merge order (last wins for same key): YAML `variables` → `.env.mcp.local` →
 * session variables. `process.env` is not merged in; use `{{env.NAME}}`.
 */
export function buildInterpolationContext(
  yamlVariables: Record<string, string> | undefined,
  envMcpLocal: Record<string, string>,
  sessionVariables: Record<string, string>,
): InterpolationContext {
  const ctx: InterpolationContext = {
    ...(yamlVariables ?? {}),
    ...envMcpLocal,
    ...sessionVariables,
  };
  literalKeysByContext.set(ctx, new Set(Object.keys(sessionVariables)));
  return ctx;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Format `date` using a small token set (no external date libs).
 * Supported tokens: YYYY, MM, DD, HH, mm (minutes), ss, SSS.
 */
export function formatDatePattern(pattern: string, d: Date): string {
  return pattern
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1, 2))
    .replace(/DD/g, pad(d.getDate(), 2))
    .replace(/HH/g, pad(d.getHours(), 2))
    .replace(/mm/g, pad(d.getMinutes(), 2))
    .replace(/ss/g, pad(d.getSeconds(), 2))
    .replace(/SSS/g, pad(d.getMilliseconds(), 3));
}

/**
 * Native macros: `{{$uuid}}`, `{{$timestamp}}`, `{{$date}}`, `{{$date:FORMAT}}`.
 * `$timestamp` is Unix time in milliseconds as a decimal string (same as `Date.now()`).
 */
function expandMacro(rawKey: string): string {
  const key = rawKey.trim();
  if (key === "$uuid") {
    return randomUUID();
  }
  if (key === "$timestamp") {
    return String(Date.now());
  }
  if (key === "$date") {
    return formatDatePattern("YYYY-MM-DD", new Date());
  }
  if (key.startsWith("$date:")) {
    const fmt = key.slice("$date:".length);
    return formatDatePattern(fmt, new Date());
  }
  return "";
}

function expand(
  template: string,
  ctx: InterpolationContext,
  depth: number,
): string {
  return template.replace(PLACEHOLDER, (_full, rawKey: string) => {
    const key = String(rawKey).trim();
    if (key.startsWith("$")) {
      return expandMacro(key);
    }
    const found = lookup(key, ctx);
    if (!found) {
      return unresolvedPlaceholder(key);
    }
    if (found.literal || depth >= MAX_INTERPOLATION_DEPTH) {
      return found.value;
    }
    return expand(found.value, ctx, depth + 1);
  });
}

/**
 * Replace `{{$macro}}`, `{{key}}` and `{{env.KEY}}`.
 * Values from YAML `variables` / `.env.mcp.local` are templates themselves
 * (`variables.x: "TESTE-{{$uuid}}"` then `{{x}}` resolves fully); session and
 * `process.env` values are inserted as-is.
 */
export function interpolateString(
  template: string,
  ctx: InterpolationContext,
): string {
  return expand(template, ctx, 0);
}

export function interpolateUnknown(
  value: unknown,
  ctx: InterpolationContext,
): unknown {
  if (typeof value === "string") {
    return interpolateString(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateUnknown(v, ctx));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateUnknown(v, ctx);
    }
    return out;
  }
  return value;
}
