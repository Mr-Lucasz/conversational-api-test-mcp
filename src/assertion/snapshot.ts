import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { JSONPath } from "jsonpath-plus";
import type { AssertSpec } from "../canonical/schema.js";

/**
 * `assert.snapshot`: the first run records the body under `.mcp/snapshots/<name>.json`; later
 * runs compare with it. `shape` (default) compares keys and value types, so it catches
 * contract drift without breaking on data that changes every day; `values` compares the
 * values too, with ids, dates and tokens masked. `MCP_UPDATE_SNAPSHOTS=1` (or `run
 * --update-snapshots`) rewrites a snapshot instead of failing.
 */

type SnapshotSpec = NonNullable<AssertSpec["snapshot"]>;
type Mode = "shape" | "values";

const MAX_DIFFS = 8;

const MASKS: Array<[RegExp, string]> = [
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "<uuid>"],
  [/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "<date>"],
  [/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/, "<jwt>"],
  [/^[0-9a-f]{24,}$/i, "<hex>"],
];

export function snapshotFile(workspaceRoot: string, name: string): string {
  return join(resolve(workspaceRoot), ".mcp", "snapshots", `${name}.json`);
}

function settings(spec: SnapshotSpec): { name: string; mode: Mode; ignore: string[] } {
  return typeof spec === "string"
    ? { name: spec, mode: "shape", ignore: [] }
    : { name: spec.name, mode: spec.mode ?? "shape", ignore: spec.ignore ?? [] };
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Drops every match of the `ignore` JSONPaths from a copy of `data`. */
function withoutIgnored(data: unknown, ignore: string[]): unknown {
  if (!ignore.length || data === null || typeof data !== "object") {
    return data;
  }
  const copy = structuredClone(data) as object;
  for (const path of ignore) {
    const hits = JSONPath({ path, json: copy, resultType: "all" }) as Array<{
      parent: Record<string | number, unknown> | unknown[] | null;
      parentProperty: string | number;
    }>;
    // Back to front, so removing list items does not shift the ones still to remove.
    for (const h of hits.reverse()) {
      if (Array.isArray(h.parent)) {
        h.parent.splice(Number(h.parentProperty), 1);
      } else if (h.parent && typeof h.parent === "object") {
        delete (h.parent as Record<string | number, unknown>)[h.parentProperty];
      }
    }
  }
  return copy;
}

/** What gets stored and compared: types only (`shape`) or masked values (`values`). */
export function normalizeForSnapshot(value: unknown, mode: Mode): unknown {
  if (Array.isArray(value)) {
    // Shape: lists vary in length; one element describes them.
    return mode === "shape"
      ? value.length
        ? [normalizeForSnapshot(value[0], mode)]
        : []
      : value.map((v) => normalizeForSnapshot(v, mode));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalizeForSnapshot(v, mode)]),
    );
  }
  if (mode === "shape") {
    return value === null ? null : `<${typeName(value)}>`;
  }
  if (typeof value === "string") {
    for (const [re, mask] of MASKS) {
      if (re.test(value)) return mask;
    }
  }
  return value;
}

function short(v: unknown): string {
  const t = JSON.stringify(v) ?? "undefined";
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

function diff(expected: unknown, actual: unknown, path: string, mode: Mode, out: string[]): void {
  if (out.length >= MAX_DIFFS) {
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (mode === "shape") {
      if (expected.length && actual.length) {
        diff(expected[0], actual[0], `${path}[*]`, mode, out);
      }
      return;
    }
    if (expected.length !== actual.length) {
      out.push(`${path}: ${expected.length} items → ${actual.length}`);
    }
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
      diff(expected[i], actual[i], `${path}[${i}]`, mode, out);
    }
    return;
  }
  const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(expected) && isObj(actual)) {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!(k in a)) out.push(`${path}.${k}: missing (was ${short(e[k])})`);
      else diff(e[k], a[k], `${path}.${k}`, mode, out);
    }
    for (const k of Object.keys(a)) {
      if (!(k in e)) out.push(`${path}.${k}: new field ${short(a[k])}`);
    }
    return;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    out.push(`${path}: ${short(expected)} → ${short(actual)}`);
  }
}

/**
 * Differences between the body and its snapshot, as assert failures. Records the snapshot
 * when there is none (unless `readOnly`), and rewrites it under MCP_UPDATE_SNAPSHOTS=1.
 */
export function snapshotFailures(
  bodyText: string,
  spec: SnapshotSpec,
  workspaceRoot: string | undefined,
  opts: { readOnly?: boolean } = {},
): string[] {
  const { name, mode, ignore } = settings(spec);
  if (!workspaceRoot) {
    return [`snapshot "${name}": no workspace to store it in`];
  }
  let data: unknown = bodyText;
  try {
    data = JSON.parse(bodyText);
  } catch {
    // text body: compared as one string
  }
  const current = normalizeForSnapshot(withoutIgnored(data, ignore), mode);
  const file = snapshotFile(workspaceRoot, name);
  const write = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ mode, ignore, body: current }, null, 2)}\n`,
      "utf8",
    );
  };
  if (!existsSync(file)) {
    if (!opts.readOnly) write();
    return [];
  }
  let stored: { mode?: Mode; body?: unknown };
  try {
    stored = JSON.parse(readFileSync(file, "utf8")) as typeof stored;
  } catch {
    return [`snapshot "${name}": ${file} is not valid JSON`];
  }
  const expected = stored.mode === mode ? stored.body : undefined;
  const diffs: string[] = [];
  if (expected === undefined) {
    diffs.push(`$: recorded in "${stored.mode}" mode, asserted in "${mode}"`);
  } else {
    diff(expected, current, "$", mode, diffs);
  }
  if (!diffs.length) {
    return [];
  }
  if (!opts.readOnly && process.env.MCP_UPDATE_SNAPSHOTS === "1") {
    write();
    return [];
  }
  return diffs.map((d) => `snapshot ${name}: ${d}`);
}
