import type { AssertSpec, ValueCheck } from "../canonical/schema.js";

/**
 * Translates the common, declarative lines of Postman scripts into canonical YAML:
 *
 * - tests: `pm.response.to.have.status(200)`, `pm.expect(pm.response.code).to.eql(201)`,
 *   `pm.expect(pm.response.responseTime).to.be.below(500)`, `pm.expect(json.a).to.eql("x")`,
 *   `.to.include(…)`, `.to.have.lengthOf(n)`, `.to.exist`, `.to.be.above/below(n)`,
 *   `pm.expect(pm.response.text()).to.include("x")` → `assert`;
 * - `pm.environment.set("token", json.data.token)` (also collectionVariables / globals /
 *   variables) → `capture`;
 * - pre-request `pm.environment.set("id", uuid.v4() | crypto.randomUUID() | Date.now() | …)`
 *   → a definition variable set to `{{$uuid}}` / `{{$timestamp}}`.
 *
 * Anything else is left out and counted, so the converter can say which requests still
 * have script logic to port by hand. This is pattern matching, not a JavaScript engine.
 */

export type ScriptTranslation = {
  assert?: AssertSpec;
  capture?: Record<string, string>;
  /** Variables a pre-request script generates, as canonical macros. */
  variables?: Record<string, string>;
  /** Script statements that were not translated. */
  unconverted: number;
};

/** A whole `pm.environment.set("name", value);` statement; the value runs to the last `)`. */
const SET_VAR =
  /^pm\.(?:environment|collectionVariables|globals|variables)\.set\(\s*(['"`])([^'"`]+)\1\s*,\s*(.+)\)\s*;?\s*$/;
const STRING_LIT = /^(['"`])(.*)\1$/s;

type Value = string | number | boolean | null;

function literal(src: string): { value: Value } | undefined {
  const s = src.trim();
  const str = STRING_LIT.exec(s);
  if (str && !(str[1] === "`" && str[2].includes("${"))) {
    return { value: str[2] };
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return { value: Number(s) };
  }
  if (s === "true" || s === "false") {
    return { value: s === "true" };
  }
  if (s === "null") {
    return { value: null };
  }
  return undefined;
}

/** Names bound to the parsed body: `var jsonData = pm.response.json();`. */
function bodyAliases(script: string): string[] {
  const out = ["pm.response.json()"];
  for (const m of script.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*pm\.response\.json\(\)/g)) {
    out.push(m[1]);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `jsonData.items[0]["full name"]` → `$.items[0]['full name']`; undefined when it is not a body path. */
function toJsonPath(expr: string, aliases: string[]): string | undefined {
  const e = expr.trim();
  for (const alias of aliases) {
    const m = new RegExp(`^${escapeRe(alias)}((?:\\.[A-Za-z_$][\\w$]*|\\[\\d+\\]|\\[(['"])[^'"\\]]+\\2\\])*)$`).exec(e);
    if (!m) {
      continue;
    }
    const rest = m[1].replace(/\[(['"])([^'"\]]+)\1\]/g, "['$2']");
    return `$${rest}`;
  }
  return undefined;
}

function translateSetVar(
  name: string,
  valueSrc: string,
  aliases: string[],
): { capture?: [string, string]; variable?: [string, string] } | undefined {
  const path = toJsonPath(valueSrc, aliases);
  if (path) {
    return { capture: [name, path] };
  }
  const v = valueSrc.trim();
  if (/\buuid\b.*\.v4\(\)|crypto\.randomUUID\(\)|\{\{\$(guid|randomUUID)\}\}|\$guid|\$randomUUID/i.test(v)) {
    return { variable: [name, "{{$uuid}}"] };
  }
  if (/^Date\.now\(\)$|^new Date\(\)\.getTime\(\)$|^\+new Date\(\)$/.test(v)) {
    return { variable: [name, "{{$timestamp}}"] };
  }
  if (/^Math\.floor\(\s*Date\.now\(\)\s*\/\s*1000\s*\)$/.test(v)) {
    return { variable: [name, "{{$timestampSeconds}}"] };
  }
  if (/^new Date\(\)\.toISOString\(\)$/.test(v)) {
    return { variable: [name, "{{$isoTimestamp}}"] };
  }
  const lit = literal(v);
  if (lit && lit.value !== null) {
    return { variable: [name, String(lit.value)] };
  }
  return undefined;
}

/** Statements that do something worth porting (not blank lines, braces or comments). */
function meaningfulStatements(script: string): string[] {
  return script
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => /\bpm\.(expect|response\.to|environment|collectionVariables|globals|variables|sendRequest|request|execution)|\bpostman\.|\btests\[/.test(l));
}

/** Translates one request's test scripts (collection + folders + request, in that order). */
export function translateTestScripts(scripts: string[]): ScriptTranslation {
  const assert: AssertSpec = {};
  const checks: ValueCheck[] = [];
  const capture: Record<string, string> = {};
  let unconverted = 0;

  for (const script of scripts) {
    const aliases = bodyAliases(script);
    for (const line of meaningfulStatements(script)) {
      if (/^pm\.test\(\s*(['"`]).*\1\s*,\s*(function\s*\(\s*\)|\(\s*\)\s*=>)\s*\{\s*$/.test(line) || /^\}\s*\)\s*;?$/.test(line)) {
        continue;
      }
      // Strip a one-line `pm.test("…", function () { … });` wrapper.
      const body = line
        .replace(/^pm\.test\(\s*(['"`]).*?\1\s*,\s*(?:function\s*\(\s*\)|\(\s*\)\s*=>)\s*\{\s*/, "")
        .replace(/\s*\}\s*\)\s*;?\s*$/, "")
        .trim();
      if (translateTestStatement(body, aliases, assert, checks, capture)) {
        continue;
      }
      unconverted += 1;
    }
  }

  if (checks.length) {
    assert.checks = checks;
  }
  return {
    ...(Object.keys(assert).length ? { assert } : {}),
    ...(Object.keys(capture).length ? { capture } : {}),
    unconverted,
  };
}

function translateTestStatement(
  stmt: string,
  aliases: string[],
  assert: AssertSpec,
  checks: ValueCheck[],
  capture: Record<string, string>,
): boolean {
  let m: RegExpExecArray | null;
  // Several statements on one line: all must translate.
  const parts = stmt.split(/;\s*(?=pm\.)/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    return parts.every((p) => translateTestStatement(p, aliases, assert, checks, capture));
  }

  if ((m = /^pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)\s*;?$/.exec(stmt))) {
    assert.status = Number(m[1]);
    return true;
  }
  if ((m = /^pm\.expect\(\s*pm\.response\.(?:code|status)\s*\)\.to\.(?:eql|equal|be\.equal|eq)\(\s*(\d{3})\s*\)\s*;?$/.exec(stmt))) {
    assert.status = Number(m[1]);
    return true;
  }
  if ((m = /^pm\.expect\(\s*pm\.response\.responseTime\s*\)\.to\.be\.(?:below|lessThan|lt|at\.most|most)\(\s*(\d+)\s*\)\s*;?$/.exec(stmt))) {
    assert.maxDurationMs = Number(m[1]);
    return true;
  }
  if (/^pm\.response\.to\.(?:be|have)\.(?:json|jsonBody)\s*;?$/.test(stmt)) {
    return true; // the JSON-path checks below already fail on a non-JSON body
  }
  if ((m = /^pm\.expect\(\s*pm\.response\.text\(\)\s*\)\.to\.(?:include|contain|have\.string)\(\s*(.+?)\s*\)\s*;?$/.exec(stmt))) {
    const lit = literal(m[1]);
    if (lit && typeof lit.value === "string") {
      checks.push({ contains: lit.value });
      return true;
    }
    return false;
  }
  if ((m = /^pm\.response\.to\.have\.jsonBody\(\s*(['"])([^'"]+)\1\s*\)\s*;?$/.exec(stmt))) {
    pushExists(`$.${m[2]}`, assert, checks);
    return true;
  }

  const setVar = SET_VAR.exec(stmt);
  if (setVar) {
    const path = toJsonPath(setVar[3], aliases);
    if (path) {
      capture[setVar[2]] = path;
      return true;
    }
    return false;
  }

  if ((m = /^pm\.expect\(\s*(.+?)\s*\)\.to\.(not\.)?(.+?)\s*;?$/.exec(stmt))) {
    const path = toJsonPath(m[1], aliases);
    if (!path) {
      return false;
    }
    const negated = Boolean(m[2]);
    const chain = m[3];
    let c: RegExpExecArray | null;
    if (!negated && /^(?:exist|be\.ok|not\.be\.undefined|be\.not\.undefined)$/.test(chain)) {
      pushExists(path, assert, checks);
      return true;
    }
    if (negated && /^(?:be\.undefined|be\.null|be\.empty)$/.test(chain)) {
      pushExists(path, assert, checks);
      return true;
    }
    if ((c = /^(?:eql|equal|eq|be\.equal|deep\.equal)\(\s*(.+)\s*\)$/.exec(chain)) && !negated) {
      const lit = literal(c[1]);
      if (!lit) return false;
      checks.push({ path, equals: lit.value as string | number | boolean | null });
      return true;
    }
    if ((c = /^(?:include|contain|have\.string)\(\s*(.+)\s*\)$/.exec(chain))) {
      const lit = literal(c[1]);
      if (!lit || typeof lit.value !== "string") return false;
      checks.push(negated ? { path, notContains: lit.value } : { path, contains: lit.value });
      return true;
    }
    if ((c = /^(?:have\.(?:lengthOf|length))\(\s*(\d+)\s*\)$/.exec(chain)) && !negated) {
      checks.push({ path, minLength: Number(c[1]), maxLength: Number(c[1]) });
      return true;
    }
    if ((c = /^be\.(above|greaterThan|gt|below|lessThan|lt|at\.least|at\.most)\(\s*(-?\d+(?:\.\d+)?)\s*\)$/.exec(chain)) && !negated) {
      const n = Number(c[2]);
      const op = c[1];
      // Strict bounds on integers become inclusive ones; on decimals they stay approximate.
      if (op === "at.least") checks.push({ path, min: n });
      else if (op === "at.most") checks.push({ path, max: n });
      else if (/above|greaterThan|gt/.test(op)) checks.push({ path, min: Number.isInteger(n) ? n + 1 : n });
      else checks.push({ path, max: Number.isInteger(n) ? n - 1 : n });
      return true;
    }
    if ((c = /^match\(\s*\/(.+)\/([a-z]*)\s*\)$/.exec(chain)) && !negated) {
      checks.push({ path, matches: c[1], ...(c[2].includes("i") ? { ignoreCase: true } : {}) });
      return true;
    }
    if (!negated && /^(?:be\.true|be\.false)$/.test(chain)) {
      checks.push({ path, equals: chain === "be.true" });
      return true;
    }
  }
  return false;
}

function pushExists(path: string, assert: AssertSpec, checks: ValueCheck[]): void {
  if (assert.jsonPathExists === undefined) {
    assert.jsonPathExists = path;
  } else {
    // Only one jsonPathExists per assert: a minLength 0 check also fails on "no match".
    checks.push({ path, minLength: 0 });
  }
}

/** Translates pre-request scripts: generated values become definition variables. */
export function translatePreRequestScripts(scripts: string[]): ScriptTranslation {
  const variables: Record<string, string> = {};
  let unconverted = 0;
  for (const script of scripts) {
    for (const line of meaningfulStatements(script)) {
      const m = SET_VAR.exec(line);
      const t = m ? translateSetVar(m[2], m[3].trim(), []) : undefined;
      if (t?.variable) {
        variables[t.variable[0]] = t.variable[1];
      } else {
        unconverted += 1;
      }
    }
  }
  return {
    ...(Object.keys(variables).length ? { variables } : {}),
    unconverted,
  };
}

/** Postman dynamic variables with a canonical equivalent. */
const DYNAMIC: Record<string, string> = {
  $guid: "$uuid",
  $randomUUID: "$uuid",
  // Postman's $timestamp is in seconds; the canonical one is in milliseconds.
  $timestamp: "$timestampSeconds",
  $isoTimestamp: "$isoTimestamp",
};

/** Rewrites Postman `{{$guid}}`-style dynamic variables in any string of a request. */
export function rewriteDynamicVariables<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*(\$[A-Za-z]+)\s*\}\}/g, (full, name: string) =>
      DYNAMIC[name] ? `{{${DYNAMIC[name]}}}` : full,
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map(rewriteDynamicVariables) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewriteDynamicVariables(v)]),
    ) as T;
  }
  return value;
}
