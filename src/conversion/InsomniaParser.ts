import type { ApiDefinitionYaml, EndpointDefinition } from "../canonical/schema.js";
import type { LegacyParserStrategy, ParseResult } from "./LegacyParserStrategy.js";

type InsomniaResource = {
  _id?: string;
  _type?: string;
  parentId?: string;
  name?: string;
  url?: string;
  method?: string;
  headers?: { name: string; value: string }[];
  body?: { text?: string };
};

export class InsomniaParser implements LegacyParserStrategy {
  readonly id = "insomnia";

  canHandle(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") {
      return false;
    }
    const o = raw as Record<string, unknown>;
    return (
      o.__export_format === 4 &&
      Array.isArray(o.resources)
    );
  }

  parse(raw: unknown, options?: { serviceName?: string }): ParseResult {
    const losses: ParseResult["losses"] = [];
    const o = raw as {
      resources?: InsomniaResource[];
    };
    const resources = o.resources ?? [];
    const requests = resources.filter((r) => r._type === "request");
    const endpoints: EndpointDefinition[] = [];
    let i = 0;
    for (const r of requests) {
      const method = (r.method ?? "GET").toUpperCase();
      let path = "/";
      if (r.url) {
        try {
          const u = new URL(r.url.startsWith("http") ? r.url : `http://x${r.url}`);
          path = u.pathname + u.search;
        } catch {
          path = r.url.startsWith("/") ? r.url : `/${r.url}`;
        }
      }
      const headers: Record<string, string> = {};
      for (const h of r.headers ?? []) {
        headers[h.name] = h.value ?? "";
      }
      let body: unknown;
      if (r.body?.text) {
        try {
          body = JSON.parse(r.body.text) as unknown;
        } catch {
          body = r.body.text;
        }
      }
      const id = `insomnia_${i++}_${sanitizeId(r.name ?? r._id ?? "req")}`;
      endpoints.push({
        id,
        method: method as EndpointDefinition["method"],
        path,
        description: r.name,
        headers: Object.keys(headers).length ? headers : undefined,
        body,
      });
    }

    const canonical: ApiDefinitionYaml = {
      version: "1",
      service: options?.serviceName ?? "imported-insomnia",
      base_url: "{{base_url}}",
      variables: { base_url: "" },
      endpoints,
    };

    return { canonical, losses, sourceLabel: "insomnia" };
  }
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
}
