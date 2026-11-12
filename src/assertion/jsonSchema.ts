import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";

/**
 * JSON Schema validation for `assert.schema`.
 *
 * The schema is either inline (an object in the YAML) or a reference to a file in the
 * workspace, `path/to/openapi.yaml#/components/schemas/Order`. A reference loads the whole
 * document, so the `$ref`s inside it (`#/components/schemas/Customer`) resolve as well.
 * OpenAPI 3.0 schemas work too: unknown keywords (`example`, `xml`, …) are ignored and
 * `nullable` is understood.
 */

type Schema = Record<string, unknown> | boolean;

// ajv-formats ships CommonJS: under NodeNext the default import is the module object.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as (ajv: Ajv2020) => Ajv2020;

const MAX_ERRORS = 5;

let ajv: Ajv2020 | undefined;
const compiled = new Map<string, { version: string; validate: ValidateFunction }>();
const inlineCompiled = new WeakMap<object, ValidateFunction>();

function getAjv(): Ajv2020 {
  if (!ajv) {
    // strict: false ignores OpenAPI-only keywords; `nullable` is rewritten by normalizeNullable.
    ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
    addFormats(ajv);
  }
  return ajv;
}

/** OpenAPI 3.0 `type: x, nullable: true` → `type: [x, "null"]`, recursively, on a copy. */
function normalizeNullable(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeNullable);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = normalizeNullable(v);
  }
  if (out.nullable === true && typeof out.type === "string") {
    out.type = [out.type, "null"];
  }
  if (out.nullable === true && Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...(out.enum as unknown[]), null];
  }
  return out;
}

/** Splits `file#/pointer` and resolves the file inside the workspace. */
export function resolveSchemaRef(
  ref: string,
  workspaceRoot: string,
): { file: string; pointer: string } {
  const hash = ref.indexOf("#");
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  if (!filePart) {
    throw new Error(`schema "${ref}": give a file, e.g. openapi.yaml#/components/schemas/Order`);
  }
  const root = resolve(workspaceRoot);
  const file = resolve(root, filePart);
  const rel = relative(root, file);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`schema "${ref}": the file must be inside the workspace`);
  }
  return { file, pointer };
}

function loadDocument(file: string): Schema {
  const text = readFileSync(file, "utf8");
  const doc = (file.endsWith(".json") ? JSON.parse(text) : parseYaml(text)) as unknown;
  if (doc === null || typeof doc !== "object") {
    throw new Error(`${file} is not a JSON/YAML object`);
  }
  return normalizeNullable(doc) as Schema;
}

function compileRef(ref: string, workspaceRoot: string): ValidateFunction {
  const { file, pointer } = resolveSchemaRef(ref, workspaceRoot);
  let version: string;
  try {
    const st = statSync(file);
    // mtime alone can repeat when a file is rewritten within the same tick.
    version = `${st.mtimeMs}-${st.size}`;
  } catch {
    throw new Error(`schema "${ref}": file not found`);
  }
  const key = `${file}#${pointer}`;
  const hit = compiled.get(key);
  if (hit && hit.version === version) {
    return hit.validate;
  }
  const a = getAjv();
  const id = `${pathToFileURL(file).href}?v=${version}`;
  if (!a.getSchema(id)) {
    const doc = loadDocument(file);
    a.addSchema(
      typeof doc === "object" ? { ...doc, $id: id } : doc,
      id,
    );
  }
  const validate = a.compile({ $ref: `${id}#${pointer}` });
  compiled.set(key, { version, validate });
  return validate;
}

function compileInline(schema: object): ValidateFunction {
  let validate = inlineCompiled.get(schema);
  if (!validate) {
    validate = getAjv().compile(normalizeNullable(schema) as Schema);
    inlineCompiled.set(schema, validate);
  }
  return validate;
}

function describe(e: ErrorObject): string {
  const at = e.instancePath || "$";
  const extra =
    e.keyword === "additionalProperties"
      ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
      : e.keyword === "enum"
        ? ` ${JSON.stringify((e.params as { allowedValues?: unknown[] }).allowedValues)}`
        : "";
  return `${at} ${e.message ?? e.keyword}${extra}`;
}

/** Problems found validating `data` against `schema`; empty when it is valid. */
export function schemaFailures(
  data: unknown,
  schema: string | object,
  workspaceRoot: string | undefined,
): string[] {
  let validate: ValidateFunction;
  try {
    if (typeof schema === "string") {
      if (!workspaceRoot) {
        return [`schema "${schema}": no workspace to resolve the file from`];
      }
      validate = compileRef(schema, workspaceRoot);
    } else {
      validate = compileInline(schema);
    }
  } catch (e) {
    return [`schema: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (validate(data)) {
    return [];
  }
  const errors = validate.errors ?? [];
  const shown = errors.slice(0, MAX_ERRORS).map((e) => `schema: ${describe(e)}`);
  if (errors.length > MAX_ERRORS) {
    shown.push(`schema: … and ${errors.length - MAX_ERRORS} more`);
  }
  return shown;
}

/** Follows `#/a/b` inside `doc`; undefined when the pointer leads nowhere. */
function atPointer(doc: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") {
    return doc;
  }
  let node = doc;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * The schema as a plain object, to read its keywords (properties, minLength…) rather than
 * validate with it. A reference loads its file; a local `$ref` on the node or on a property
 * is followed once, which covers the usual `components/schemas` layout.
 */
export function loadSchemaObject(
  schema: string | object,
  workspaceRoot: string | undefined,
): Record<string, unknown> | undefined {
  let doc: unknown = schema;
  let node: unknown;
  if (typeof schema === "string") {
    if (!workspaceRoot) {
      return undefined;
    }
    const { file, pointer } = resolveSchemaRef(schema, workspaceRoot);
    doc = loadDocument(file);
    node = atPointer(doc, pointer);
  } else {
    doc = normalizeNullable(schema);
    node = doc;
  }
  const deref = (n: unknown): unknown => {
    const ref = (n as { $ref?: unknown } | null)?.$ref;
    return typeof ref === "string" && ref.startsWith("#") ? atPointer(doc, ref.slice(1)) : n;
  };
  const root = deref(node);
  if (root === null || typeof root !== "object") {
    return undefined;
  }
  const out = { ...(root as Record<string, unknown>) };
  const props = out.properties;
  if (props && typeof props === "object") {
    out.properties = Object.fromEntries(
      Object.entries(props as Record<string, unknown>).map(([k, v]) => [k, deref(v)]),
    );
  }
  return out;
}
