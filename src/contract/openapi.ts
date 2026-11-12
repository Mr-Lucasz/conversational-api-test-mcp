/**
 * Small helpers over an OpenAPI 3.x / Swagger 2 document: find the operation a request
 * goes to, and the JSON Schema documented for one of its responses.
 */

export type OpenApiDoc = {
  openapi?: string;
  swagger?: string;
  basePath?: string;
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, unknown>>;
};

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch"] as const;

/** JSON pointer escaping: `~` → `~0`, `/` → `~1`. */
export function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The path prefix every operation lives under (`/v1` from `https://api.x.com/v1`). */
function basePath(doc: OpenApiDoc): string {
  if (doc.basePath) {
    return doc.basePath.replace(/\/$/, "");
  }
  const url = doc.servers?.[0]?.url ?? "";
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/\{[^}]+\}/g, "");
  return path.replace(/\/$/, "");
}

function templateRegex(template: string): RegExp {
  const body = template
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}/?$`);
}

/**
 * The OpenAPI path template a canonical path corresponds to. Placeholders (`{{id}}`,
 * `{id}`) and literal values (`/orders/7`) both match a `{param}` segment; the document's
 * base path may or may not be part of the canonical path.
 */
export function findOperation(
  doc: OpenApiDoc,
  method: string,
  canonicalPath: string,
): { template: string; operation: Record<string, unknown> } | undefined {
  const m = method.toLowerCase();
  const raw = canonicalPath.split("?")[0] ?? canonicalPath;
  const concrete = raw.replace(/\{\{[^}]+\}\}|\{[^}]+\}/g, "x");
  const base = basePath(doc);
  const candidates = [concrete];
  if (base && concrete.startsWith(base)) {
    candidates.push(concrete.slice(base.length) || "/");
  }
  const paths = Object.entries(doc.paths ?? {});
  // Exact (literal) templates first, so `/orders/mine` wins over `/orders/{id}`.
  paths.sort(([a], [b]) => (a.match(/\{/g)?.length ?? 0) - (b.match(/\{/g)?.length ?? 0));
  for (const candidate of candidates) {
    for (const [template, item] of paths) {
      const operation = item?.[m];
      if (operation && typeof operation === "object" && templateRegex(template).test(candidate)) {
        return { template, operation: operation as Record<string, unknown> };
      }
    }
  }
  return undefined;
}

/**
 * Where the schema of the response with `status` lives, as a JSON pointer into the
 * document — `undefined` schema pointer when the response is documented without a body.
 */
export function responseSchemaPointer(
  doc: OpenApiDoc,
  template: string,
  method: string,
  status: number,
): { documented: boolean; code?: string; pointer?: string } {
  const op = doc.paths?.[template]?.[method.toLowerCase()] as
    | { responses?: Record<string, Record<string, unknown>> }
    | undefined;
  const responses = op?.responses ?? {};
  const code = [String(status), `${String(status)[0]}XX`, `${String(status)[0]}xx`, "default"].find(
    (c) => responses[c] !== undefined,
  );
  if (!code) {
    return { documented: false };
  }
  const base = `/paths/${escapePointer(template)}/${method.toLowerCase()}/responses/${escapePointer(code)}`;
  const res = responses[code] as { schema?: unknown; content?: Record<string, { schema?: unknown }> };
  if (res.schema !== undefined) {
    return { documented: true, code, pointer: `${base}/schema` };
  }
  const media = Object.keys(res.content ?? {}).find((t) => /json/i.test(t));
  if (media && res.content?.[media]?.schema !== undefined) {
    return { documented: true, code, pointer: `${base}/content/${escapePointer(media)}/schema` };
  }
  return { documented: true, code };
}

/** The success response a request should get, for import-time `assert.schema`. */
export function successSchemaPointer(
  doc: OpenApiDoc,
  template: string,
  method: string,
): { status: number; pointer: string } | undefined {
  const op = doc.paths?.[template]?.[method.toLowerCase()] as
    | { responses?: Record<string, unknown> }
    | undefined;
  const code = Object.keys(op?.responses ?? {}).find((c) => /^2\d\d$/.test(c));
  if (!code) {
    return undefined;
  }
  const r = responseSchemaPointer(doc, template, method, Number(code));
  return r.pointer ? { status: Number(code), pointer: r.pointer } : undefined;
}
