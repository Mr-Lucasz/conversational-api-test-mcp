import type { ApiDefinitionYaml, EndpointDefinition } from "../canonical/schema.js";
import { escapePointer, successSchemaPointer, type OpenApiDoc } from "../contract/openapi.js";
import type { LegacyParserStrategy, ParseOptions, ParseResult } from "./LegacyParserStrategy.js";

type OasPathItem = Record<string, unknown>;
type OasOperation = {
  operationId?: unknown;
  summary?: unknown;
  description?: unknown;
  requestBody?: { content?: Record<string, { schema?: unknown; example?: unknown }> };
};

export class OpenApiParser implements LegacyParserStrategy {
  readonly id = "openapi";

  canHandle(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") {
      return false;
    }
    const o = raw as Record<string, unknown>;
    return typeof o.openapi === "string" || typeof o.swagger === "string";
  }

  parse(raw: unknown, options?: ParseOptions): ParseResult {
    const losses: ParseResult["losses"] = [];
    const o = raw as OpenApiDoc & { info?: { title?: string }; paths?: Record<string, OasPathItem> };
    const baseUrl = o.servers?.[0]?.url ?? "{{base_url}}";
    const src = options?.sourceRelativePath;
    const endpoints: EndpointDefinition[] = [];
    let n = 0;
    let bodiesWithoutExample = 0;
    const paths = o.paths ?? {};
    for (const [p, item] of Object.entries(paths)) {
      for (const method of ["get", "post", "put", "patch", "delete", "head", "options"] as const) {
        const op = item[method] as OasOperation | undefined;
        if (!op) {
          continue;
        }
        const opId =
          (typeof op.operationId === "string" && op.operationId) ||
          `${method}_${p.replace(/[^a-zA-Z0-9]+/g, "_")}_${n++}`;
        const ep: EndpointDefinition = {
          id: `oas_${sanitizeId(opId)}`,
          method: method.toUpperCase() as EndpointDefinition["method"],
          // `{petId}` becomes a placeholder the user (or a capture) fills.
          path: p.replace(/\{([^}]+)\}/g, "{{$1}}"),
          description:
            typeof op.summary === "string"
              ? op.summary
              : typeof op.description === "string"
                ? op.description
                : undefined,
        };
        const media = Object.keys(op.requestBody?.content ?? {}).find((t) => /json/i.test(t));
        if (media) {
          const content = op.requestBody?.content?.[media];
          if (content?.example !== undefined) {
            ep.body = content.example;
          } else {
            bodiesWithoutExample++;
          }
          if (src && content?.schema !== undefined) {
            ep.body_schema = `${src}#/paths/${escapePointer(p)}/${method}/requestBody/content/${escapePointer(media)}/schema`;
          }
        }
        // With the spec in the workspace, every run checks the response against it.
        const success = src ? successSchemaPointer(o, p, method) : undefined;
        if (success) {
          ep.assert = { status: success.status, schema: `${src}#${success.pointer}` };
        }
        endpoints.push(ep);
      }
    }

    if (bodiesWithoutExample) {
      losses.push({
        code: "OAS_BODY_EXAMPLE",
        message: `${bodiesWithoutExample} request bodies have a schema but no example: fill \`body\` before sending them.`,
      });
    }
    if (!src) {
      losses.push({
        code: "OAS_NO_SCHEMA_LINK",
        message:
          "The spec was pasted, not read from a file: responses are not linked to its schemas. Save it in the workspace and convert from the file to get `assert.schema` on every endpoint.",
      });
    }

    const canonical: ApiDefinitionYaml = {
      version: "1",
      service: options?.serviceName ?? o.info?.title ?? "imported-openapi",
      base_url: baseUrl,
      variables: { base_url: baseUrl.startsWith("{{") ? "" : baseUrl },
      endpoints,
    };

    return { canonical, losses, sourceLabel: "openapi" };
  }
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
}
