import type { ApiDefinitionYaml, EndpointDefinition } from "../canonical/schema.js";
import type { LegacyParserStrategy, ParseResult } from "./LegacyParserStrategy.js";

type OasPathItem = Record<string, unknown>;

export class OpenApiParser implements LegacyParserStrategy {
  readonly id = "openapi";

  canHandle(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") {
      return false;
    }
    const o = raw as Record<string, unknown>;
    return typeof o.openapi === "string" || typeof o.swagger === "string";
  }

  parse(raw: unknown, options?: { serviceName?: string }): ParseResult {
    const losses: ParseResult["losses"] = [];
    const o = raw as {
      openapi?: string;
      swagger?: string;
      info?: { title?: string };
      paths?: Record<string, OasPathItem>;
      servers?: { url?: string }[];
    };
    const baseUrl =
      o.servers?.[0]?.url ?? "{{base_url}}";
    const endpoints: EndpointDefinition[] = [];
    let n = 0;
    const paths = o.paths ?? {};
    for (const [p, item] of Object.entries(paths)) {
      for (const method of [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
      ] as const) {
        const op = item[method] as Record<string, unknown> | undefined;
        if (!op) {
          continue;
        }
        const opId =
          (typeof op.operationId === "string" && op.operationId) ||
          `${method}_${p.replace(/[^a-zA-Z0-9]+/g, "_")}_${n++}`;
        const id = `oas_${sanitizeId(opId)}`;
        endpoints.push({
          id,
          method: method.toUpperCase() as EndpointDefinition["method"],
          path: p,
          description:
            typeof op.summary === "string"
              ? op.summary
              : typeof op.description === "string"
                ? op.description
                : undefined,
        });
      }
    }

    losses.push({
      code: "OAS_REF",
      message:
        "$ref resolution and requestBody examples are not fully expanded in v1 import.",
    });

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
