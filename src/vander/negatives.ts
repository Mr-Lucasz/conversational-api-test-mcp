import { loadSchemaObject } from "../assertion/jsonSchema.js";
import type { EndpointDefinition } from "../canonical/schema.js";

/** One body field replaced (or added) with a value the API should refuse. */
export type NegativeProbe = {
  id: string;
  title: string;
  key: string;
  value: unknown;
  /** Unknown extra fields may be ignored: only a server error fails those. */
  expect: "4xx" | "not5xx";
};

/** Cap on generated probes, so one endpoint does not send dozens of requests. */
export const MAX_NEGATIVE_PROBES = 16;
const MAX_KEYS = 6;

type Prop = Record<string, unknown>;

function typeOf(value: unknown, prop?: Prop): string | undefined {
  const declared = prop?.type;
  if (typeof declared === "string") {
    return declared;
  }
  if (Array.isArray(declared)) {
    return declared.find((t) => t !== "null") as string | undefined;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
}

/** A value of the wrong JSON type for `type`. */
function wrongTypeFor(type: string): unknown {
  switch (type) {
    case "string":
      return 12345;
    case "integer":
    case "number":
      return "not-a-number";
    case "boolean":
      return "yes";
    case "array":
      return { vander: "object instead of a list" };
    case "object":
      return "text instead of an object";
    default:
      return [];
  }
}

function nullable(prop?: Prop): boolean {
  const t = prop?.type;
  return prop?.nullable === true || (Array.isArray(t) && t.includes("null"));
}

/**
 * Negative probes for the JSON body of `ep`: wrong type, null and empty string per field
 * (from the example body), boundaries, enums and formats when `body_schema` describes them,
 * and one unknown extra field.
 */
export function buildNegativeProbes(
  ep: EndpointDefinition,
  workspaceRoot?: string,
): { probes: NegativeProbe[]; schemaError?: string } {
  const body =
    ep.body !== null && typeof ep.body === "object" && !Array.isArray(ep.body)
      ? (ep.body as Record<string, unknown>)
      : undefined;
  let schema: Prop | undefined;
  let schemaError: string | undefined;
  if (ep.body_schema !== undefined) {
    try {
      schema = loadSchemaObject(ep.body_schema, workspaceRoot);
    } catch (e) {
      schemaError = e instanceof Error ? e.message : String(e);
    }
  }
  const props = (schema?.properties ?? {}) as Record<string, Prop>;
  if (!body && !Object.keys(props).length) {
    return { probes: [], schemaError };
  }

  const keys = [...new Set([...Object.keys(body ?? {}), ...Object.keys(props)])].slice(
    0,
    MAX_KEYS,
  );
  const probes: NegativeProbe[] = [];
  const add = (p: NegativeProbe) => {
    if (!probes.some((q) => q.id === p.id)) {
      probes.push(p);
    }
  };

  for (const key of keys) {
    const prop = props[key];
    const type = typeOf(body?.[key], prop);
    if (type) {
      add({
        id: `N-type-${key}`,
        title: `"${key}" with the wrong type (${type} expected) is rejected`,
        key,
        value: wrongTypeFor(type),
        expect: "4xx",
      });
    }
    if (!nullable(prop)) {
      add({ id: `N-null-${key}`, title: `"${key}": null is rejected`, key, value: null, expect: "4xx" });
    }
    if (type === "string" && (prop === undefined || prop.minLength !== 0)) {
      add({
        id: `N-empty-${key}`,
        title: `"${key}": empty string is rejected`,
        key,
        value: "",
        expect: "4xx",
      });
    }
    if (!prop) {
      continue;
    }
    if (typeof prop.maxLength === "number") {
      add({
        id: `N-maxlen-${key}`,
        title: `"${key}" longer than maxLength ${prop.maxLength} is rejected`,
        key,
        value: "x".repeat(prop.maxLength + 1),
        expect: "4xx",
      });
    }
    if (typeof prop.minLength === "number" && prop.minLength > 1) {
      add({
        id: `N-minlen-${key}`,
        title: `"${key}" shorter than minLength ${prop.minLength} is rejected`,
        key,
        value: "x".repeat(prop.minLength - 1),
        expect: "4xx",
      });
    }
    const step = type === "integer" ? 1 : 0.5;
    if (typeof prop.maximum === "number") {
      add({
        id: `N-max-${key}`,
        title: `"${key}" above maximum ${prop.maximum} is rejected`,
        key,
        value: prop.maximum + step,
        expect: "4xx",
      });
    }
    if (typeof prop.minimum === "number") {
      add({
        id: `N-min-${key}`,
        title: `"${key}" below minimum ${prop.minimum} is rejected`,
        key,
        value: prop.minimum - step,
        expect: "4xx",
      });
    }
    if (Array.isArray(prop.enum) && prop.enum.length) {
      add({
        id: `N-enum-${key}`,
        title: `"${key}" outside its enum is rejected`,
        key,
        value: "vander-not-in-enum",
        expect: "4xx",
      });
    }
    if (prop.format === "email" || prop.format === "uuid" || prop.format === "date-time" || prop.format === "uri") {
      add({
        id: `N-format-${key}`,
        title: `"${key}" that is not a valid ${prop.format} is rejected`,
        key,
        value: "vander-bad-format",
        expect: "4xx",
      });
    }
  }

  if (schema?.additionalProperties === false || body) {
    add({
      id: "N-extra-field",
      title: "Unknown extra field is ignored or rejected, never a server error",
      key: "vander_unknown_field",
      value: "unexpected",
      expect: schema?.additionalProperties === false ? "4xx" : "not5xx",
    });
  }
  return { probes: probes.slice(0, MAX_NEGATIVE_PROBES), schemaError };
}
