import { JSONPath } from "jsonpath-plus";
import type { AssertSpec, ValueCheck } from "../canonical/schema.js";
import { maskIfSensitive } from "../http/redact.js";
import { safeSliceString } from "../http/safeSlice.js";
import type { LastHttpResponse } from "../session/SessionStore.js";

export type { AssertSpec } from "../canonical/schema.js";

const SNIPPET_CHARS = 120;
export const NO_MATCH = Symbol("no match");

function asList(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

/**
 * The value at `path`: a single match as itself, several as a list. An empty list
 * is a value (`citations: []` is what a refusal should return), not a miss.
 */
export function valueAt(data: unknown, path: string): unknown {
  const hit = JSONPath({ path, json: data as object, wrap: false });
  return hit === undefined ? NO_MATCH : hit;
}

/** Every match of `path` as a list — `$.ids` and `$.items[*].id` both give the ids. */
export function listAt(data: unknown, path: string): unknown[] {
  const hits = JSONPath({ path, json: data as object, wrap: true }) as unknown[];
  return hits.length === 1 && Array.isArray(hits[0]) ? hits[0] : hits;
}

export function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.join("\n");
  }
  return value === null || typeof value !== "object"
    ? String(value)
    : JSON.stringify(value);
}

function snippet(label: string, text: string): string {
  const shown = maskIfSensitive(label, text);
  return shown.length > SNIPPET_CHARS
    ? `${safeSliceString(shown, SNIPPET_CHARS)}…`
    : shown;
}

/** Problems found by one check; empty when it holds. */
function runCheck(
  check: ValueCheck,
  bodyText: string,
  data: unknown,
  isJson: boolean,
): string[] {
  const label = check.path ?? "body";
  if (check.path !== undefined && !isJson) {
    return [`${label}: response body is not JSON`];
  }
  const value = check.path === undefined ? bodyText : valueAt(data, check.path);
  if (value === NO_MATCH) {
    return [`${label}: no match`];
  }
  const text = asText(value);
  const fold = (s: string) => (check.ignoreCase ? s.toLowerCase() : s);
  const has = (needle: string) => fold(text).includes(fold(needle));
  const got = () => `got "${snippet(label, text)}"`;
  const out: string[] = [];
  const fail = (what: string) => out.push(`${label}: ${what}`);

  if (check.contains !== undefined) {
    const missing = asList(check.contains).filter((n) => !has(n));
    if (missing.length) {
      fail(`does not contain ${JSON.stringify(missing)}; ${got()}`);
    }
  }
  if (check.containsAny !== undefined && !check.containsAny.some(has)) {
    fail(`contains none of ${JSON.stringify(check.containsAny)}; ${got()}`);
  }
  if (check.notContains !== undefined) {
    const found = asList(check.notContains).filter(has);
    if (found.length) {
      fail(`contains ${JSON.stringify(found)}`);
    }
  }
  if (check.matches !== undefined) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(check.matches, check.ignoreCase ? "i" : "");
    } catch {
      fail(`invalid regular expression /${check.matches}/`);
    }
    if (re && !re.test(text)) {
      fail(`does not match /${check.matches}/; ${got()}`);
    }
  }
  if (
    check.equals !== undefined &&
    JSON.stringify(value) !== JSON.stringify(check.equals)
  ) {
    fail(`expected ${JSON.stringify(check.equals)}; ${got()}`);
  }
  if (check.min !== undefined || check.max !== undefined) {
    if (typeof value !== "number") {
      fail(`expected a number; ${got()}`);
    } else if (check.min !== undefined && value < check.min) {
      fail(`${value} is below ${check.min}`);
    } else if (check.max !== undefined && value > check.max) {
      fail(`${value} is above ${check.max}`);
    }
  }
  if (check.minLength !== undefined || check.maxLength !== undefined) {
    const length =
      typeof value === "string"
        ? value.length
        : check.path === undefined
          ? bodyText.length
          : listAt(data, check.path).length;
    if (check.minLength !== undefined && length < check.minLength) {
      fail(`length ${length} is below ${check.minLength}`);
    }
    if (check.maxLength !== undefined && length > check.maxLength) {
      fail(`length ${length} is above ${check.maxLength}`);
    }
  }

  const needsList =
    check.includesAll !== undefined ||
    check.includesAny !== undefined ||
    check.subsetOf !== undefined;
  if (needsList) {
    if (check.path === undefined) {
      return [...out, `${label}: includesAll / includesAny / subsetOf need a path`];
    }
    // Ids compared as text: `7` in the YAML matches `"7"` in the response.
    const actual = new Set(listAt(data, check.path).map(String));
    if (check.includesAll !== undefined) {
      const wanted = check.includesAll.map(String);
      const missing = wanted.filter((w) => !actual.has(w));
      const ratio = (wanted.length - missing.length) / wanted.length;
      if (ratio < (check.minRatio ?? 1)) {
        fail(
          `has ${wanted.length - missing.length} of ${wanted.length} expected values` +
            (check.minRatio === undefined ? "" : ` (needs ${check.minRatio})`) +
            `; missing ${JSON.stringify(missing)}`,
        );
      }
    }
    if (
      check.includesAny !== undefined &&
      !check.includesAny.some((w) => actual.has(String(w)))
    ) {
      fail(`has none of ${JSON.stringify(check.includesAny)}`);
    }
    if (check.subsetOf !== undefined) {
      const allowed = new Set(listAt(data, check.subsetOf).map(String));
      const stray = [...actual].filter((a) => !allowed.has(a));
      if (stray.length) {
        fail(`${JSON.stringify(stray)} not found at ${check.subsetOf}`);
      }
    }
  }
  return out;
}

/** Every way the response falls short of `spec`; empty when it satisfies it. */
export function collectAssertFailures(
  response: LastHttpResponse,
  spec: AssertSpec,
): string[] {
  const out: string[] = [];
  if (spec.status !== undefined && response.status !== spec.status) {
    out.push(`Expected status ${spec.status}, got ${response.status}`);
  }
  if (spec.maxDurationMs !== undefined) {
    if (response.durationMs === undefined) {
      out.push("maxDurationMs: the duration of this response was not recorded");
    } else if (response.durationMs > spec.maxDurationMs) {
      out.push(
        `Took ${response.durationMs}ms, over the ${spec.maxDurationMs}ms budget`,
      );
    }
  }

  const needsBody = spec.jsonPathExists !== undefined || spec.checks?.length;
  if (!needsBody) {
    return out;
  }
  let data: unknown;
  let isJson = true;
  try {
    data = JSON.parse(response.bodyText) as unknown;
  } catch {
    isJson = false;
  }
  if (spec.jsonPathExists !== undefined) {
    if (!isJson) {
      out.push("Response body is not JSON");
    } else {
      const hit = valueAt(data, spec.jsonPathExists);
      if (
        hit === NO_MATCH ||
        hit === null ||
        (Array.isArray(hit) && hit.length === 0)
      ) {
        out.push(`jsonPathExists no match: ${spec.jsonPathExists}`);
      }
    }
  }
  for (const check of spec.checks ?? []) {
    out.push(...runCheck(check, response.bodyText, data, isJson));
  }
  return out;
}

export function assertOnResponse(
  response: LastHttpResponse,
  spec: AssertSpec,
): { ok: true } | { ok: false; message: string } {
  const failures = collectAssertFailures(response, spec);
  return failures.length
    ? { ok: false, message: failures.join("; ") }
    : { ok: true };
}
