import { derefLocal, loadSchemaDocument } from "../assertion/jsonSchema.js";

/**
 * A plausible value for a JSON Schema: `example` / `default` / first `enum` when the schema
 * gives one, otherwise a value built from its type and format. Used by the mock server and
 * the Pact export when no real response was recorded.
 */

const MAX_DEPTH = 6;

const FORMATS: Record<string, string> = {
  email: "user@example.com",
  uuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "date-time": "2026-01-01T12:00:00Z",
  date: "2026-01-01",
  uri: "https://example.com",
  url: "https://example.com",
  ipv4: "192.0.2.1",
};

function sampleNode(doc: unknown, raw: unknown, depth: number): unknown {
  const node = derefLocal(doc, raw) as Record<string, unknown> | undefined;
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) {
    return null;
  }
  if (node.example !== undefined) return node.example;
  if (node.default !== undefined) return node.default;
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
  if (node.const !== undefined) return node.const;
  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    const list = node[key];
    if (Array.isArray(list) && list.length) {
      if (key === "allOf") {
        return Object.assign(
          {},
          ...list.map((s) => {
            const v = sampleNode(doc, s, depth + 1);
            return v && typeof v === "object" ? v : {};
          }),
        );
      }
      return sampleNode(doc, list[0], depth + 1);
    }
  }
  const type = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
  if (type === "object" || (type === undefined && node.properties)) {
    const props = (node.properties ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sampleNode(doc, v, depth + 1)]));
  }
  if (type === "array") {
    return node.items === undefined ? [] : [sampleNode(doc, node.items, depth + 1)];
  }
  if (type === "integer" || type === "number") {
    return typeof node.minimum === "number" ? node.minimum : 1;
  }
  if (type === "boolean") return true;
  if (type === "string") {
    const fmt = typeof node.format === "string" ? FORMATS[node.format] : undefined;
    if (fmt) return fmt;
    const min = typeof node.minLength === "number" ? node.minLength : 0;
    return "string".padEnd(min, "x");
  }
  return null;
}

/** Sample for an inline schema or a `file#/pointer` reference in the workspace. */
export function sampleFromSchema(schema: string | object, workspaceRoot?: string): unknown {
  const loaded = loadSchemaDocument(schema, workspaceRoot);
  return loaded ? sampleNode(loaded.doc, loaded.node, 0) : null;
}
