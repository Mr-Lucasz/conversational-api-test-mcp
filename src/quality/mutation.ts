import { collectAssertFailures } from "../assertion/assertResponse.js";
import type { AssertSpec } from "../canonical/schema.js";
import type { LastHttpResponse } from "../session/SessionStore.js";

/**
 * Mutation testing for API assertions: a recorded response is broken in small, realistic
 * ways (a field disappears, changes type, a list comes back empty, the status turns 500…)
 * and the asserts are run against each copy. A mutant no assert notices "survives": the
 * test would stay green if the API regressed that way. Nothing is sent over the network.
 */

export type Mutant = {
  id: string;
  /** What changed, in words. */
  change: string;
  /** An assert that would catch it (YAML-ready). */
  suggestion: Record<string, unknown>;
  response: LastHttpResponse;
};

const MAX_PATHS = 20;
const MAX_DEPTH = 4;

/** `$.a.b[0]` — bracket notation for keys JSONPath would misread. */
function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") {
    return `${parent}[${key}]`;
  }
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}['${key.replace(/'/g, "\\'")}']`;
}

type Leaf = { path: string; parent: unknown; key: string | number; value: unknown };

/** Every value in the body worth mutating: object fields and the first element of each list. */
function collectNodes(data: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= MAX_PATHS * 2) {
      return;
    }
    if (Array.isArray(node)) {
      if (node.length) {
        out.push({ path: childPath(path, 0), parent: node, key: 0, value: node[0] });
        walk(node[0], childPath(path, 0), depth + 1);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        out.push({ path: childPath(path, k), parent: node, key: k, value: v });
        walk(v, childPath(path, k), depth + 1);
      }
    }
  };
  walk(data, "$", 0);
  return out;
}

function pathSegments(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['((?:[^'\\]|\\.)*)'\]/g;
  for (const m of path.slice(1).matchAll(re)) {
    segments.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : (m[3] as string).replace(/\\'/g, "'")));
  }
  return segments;
}

/** Applies `edit` to a deep copy at the same location as `leaf`. */
function mutateAt(
  data: unknown,
  leaf: Leaf,
  edit: (parent: Record<string | number, unknown>, key: string | number) => void,
): unknown {
  const copy = structuredClone(data);
  const segments = pathSegments(leaf.path);
  let parent = copy as Record<string | number, unknown>;
  for (const s of segments.slice(0, -1)) {
    parent = parent[s] as Record<string | number, unknown>;
  }
  edit(parent, segments[segments.length - 1] as string | number);
  return copy;
}

function jsonType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** A JSON Schema that pins the type of the value at `path` (required all the way down). */
function schemaFor(path: string, value: unknown): Record<string, unknown> {
  let node: Record<string, unknown> = { type: jsonType(value) === "integer" ? "number" : jsonType(value) };
  for (const seg of pathSegments(path).reverse()) {
    node =
      typeof seg === "number"
        ? { type: "array", items: node }
        : { type: "object", required: [seg], properties: { [seg]: node } };
  }
  return node;
}

function withBody(base: LastHttpResponse, body: unknown): LastHttpResponse {
  return { ...base, bodyText: typeof body === "string" ? body : JSON.stringify(body) };
}

function otherType(value: unknown): unknown {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value === "" ? 0 : value.length;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return {};
  return [];
}

/** Realistic regressions of `response`, each with the assert that would catch it. */
export function generateMutants(response: LastHttpResponse): Mutant[] {
  const out: Mutant[] = [];
  const ok = response.status >= 200 && response.status < 300;
  out.push({
    id: "status-500",
    change: `status ${response.status} → 500`,
    suggestion: { status: response.status },
    response: { ...response, status: 500 },
  });
  out.push(
    ok
      ? {
          id: "status-404",
          change: `status ${response.status} → 404`,
          suggestion: { status: response.status },
          response: { ...response, status: 404 },
        }
      : {
          id: "status-200",
          change: `status ${response.status} → 200`,
          suggestion: { status: response.status },
          response: { ...response, status: 200 },
        },
  );
  if (response.durationMs !== undefined) {
    out.push({
      id: "slow",
      change: `took ${response.durationMs * 10 + 1000}ms instead of ${response.durationMs}ms`,
      suggestion: { maxDurationMs: Math.max(200, response.durationMs * 3) },
      response: { ...response, durationMs: response.durationMs * 10 + 1000 },
    });
  }

  let data: unknown;
  try {
    data = JSON.parse(response.bodyText);
  } catch {
    if (response.bodyText) {
      out.push({
        id: "body-empty",
        change: "body came back empty",
        suggestion: { checks: [{ contains: response.bodyText.trim().slice(0, 30) }] },
        response: withBody(response, ""),
      });
    }
    return out;
  }
  if (data !== null && typeof data === "object") {
    out.push({
      id: "body-empty",
      change: Array.isArray(data) ? "body came back as []" : "body came back as {}",
      suggestion: Array.isArray(data)
        ? { checks: [{ path: "$", minLength: 1 }] }
        : { jsonPathExists: collectNodes(data)[0]?.path ?? "$" },
      response: withBody(response, Array.isArray(data) ? [] : {}),
    });
  }

  for (const leaf of collectNodes(data).slice(0, MAX_PATHS)) {
    const { path, value } = leaf;
    const inArray = typeof leaf.key === "number";
    if (!inArray) {
      out.push({
        id: `drop:${path}`,
        change: `${path} disappeared`,
        suggestion: { jsonPathExists: path },
        response: withBody(response, mutateAt(data, leaf, (p, k) => delete p[k])),
      });
    }
    if (value !== null) {
      out.push({
        id: `type:${path}`,
        change: `${path} changed type (${jsonType(value)} → ${jsonType(otherType(value))})`,
        suggestion: { schema: schemaFor(path, value) },
        response: withBody(response, mutateAt(data, leaf, (p, k) => void (p[k] = otherType(value)))),
      });
      out.push({
        id: `null:${path}`,
        change: `${path} became null`,
        suggestion: { schema: schemaFor(path, value) },
        response: withBody(response, mutateAt(data, leaf, (p, k) => void (p[k] = null))),
      });
    }
    if (Array.isArray(value) && value.length) {
      out.push({
        id: `emptylist:${path}`,
        change: `${path} came back empty`,
        suggestion: { checks: [{ path, minLength: 1 }] },
        response: withBody(response, mutateAt(data, leaf, (p, k) => void (p[k] = []))),
      });
    }
    if (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= 60)) {
      const changed =
        typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : `${value}-x`;
      out.push({
        id: `value:${path}`,
        change: `${path} changed value (${JSON.stringify(value)} → ${JSON.stringify(changed)})`,
        suggestion: { checks: [{ path, equals: value }] },
        response: withBody(response, mutateAt(data, leaf, (p, k) => void (p[k] = changed))),
      });
    }
  }
  return out;
}

export type MutationReport = {
  /** The asserts fail on the real response itself: scoring would be meaningless. */
  baselineFailures?: string[];
  total: number;
  killed: number;
  /** killed / total, two decimals. */
  score: number;
  survivors: Array<{ id: string; change: string; suggestion: Record<string, unknown> }>;
};

/** Runs every assert in `specs` against each mutant of `response`. */
export function scoreAssertions(
  response: LastHttpResponse,
  specs: AssertSpec[],
  workspaceRoot?: string,
): MutationReport {
  // Snapshots are compared read-only here: a mutant must never become the recorded baseline.
  const run = (r: LastHttpResponse) =>
    specs.flatMap((s) => collectAssertFailures(r, s, workspaceRoot, { readOnlySnapshots: true }));
  const baseline = run(response);
  if (baseline.length) {
    return { baselineFailures: baseline, total: 0, killed: 0, score: 0, survivors: [] };
  }
  const mutants = generateMutants(response);
  const survivors = mutants.filter((m) => run(m.response).length === 0);
  const killed = mutants.length - survivors.length;
  return {
    total: mutants.length,
    killed,
    score: mutants.length ? Math.round((killed / mutants.length) * 100) / 100 : 1,
    survivors: survivors.map(({ id, change, suggestion }) => ({ id, change, suggestion })),
  };
}
