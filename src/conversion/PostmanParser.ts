import type { ApiDefinitionYaml, EndpointDefinition } from "../canonical/schema.js";
import {
  buildPostmanScriptLosses,
  detectPostmanScriptSignals,
  mergePostmanScriptSignals,
  type PostmanScriptSignals,
} from "./knownLosses.js";
import type { LegacyParserStrategy, ParseResult } from "./LegacyParserStrategy.js";

type PostmanEvent = {
  listen?: string;
  script?: { exec?: string[] };
};

type PostmanItem = {
  name?: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  event?: PostmanEvent[];
};

type PostmanRequest = {
  method?: string;
  header?: { key: string; value: string }[];
  body?: { mode?: string; raw?: string };
  url?: PostmanUrl | string;
};

type PostmanUrl = {
  raw?: string;
  host?: string[];
  path?: string[];
  query?: { key: string; value: string }[];
};

function urlToPath(url: PostmanUrl | string | undefined): string {
  if (!url) {
    return "/";
  }
  if (typeof url === "string") {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url.startsWith("/") ? url : `/${url}`;
    }
  }
  if (url.raw) {
    try {
      const u = new URL(url.raw);
      return u.pathname + u.search;
    } catch {
      const path = (url.path ?? []).join("/");
      return path ? `/${path}` : "/";
    }
  }
  const path = (url.path ?? []).join("/");
  return path ? `/${path}` : "/";
}

function collectItems(
  items: PostmanItem[] | undefined,
  out: { name: string; req: PostmanRequest }[],
  prefix: string,
): void {
  if (!items) {
    return;
  }
  for (const it of items) {
    const name = prefix ? `${prefix}/${it.name ?? "item"}` : (it.name ?? "item");
    if (it.item?.length) {
      collectItems(it.item, out, name);
    }
    if (it.request) {
      out.push({ name, req: it.request });
    }
  }
}

function walkPostmanItems(
  items: PostmanItem[] | undefined,
  visit: (item: PostmanItem) => void,
): void {
  if (!items) {
    return;
  }
  for (const it of items) {
    visit(it);
    walkPostmanItems(it.item, visit);
  }
}

function pushEventScripts(
  events: PostmanEvent[] | undefined,
  prerequest: string[],
  test: string[],
): void {
  if (!events?.length) {
    return;
  }
  for (const ev of events) {
    const exec = ev.script?.exec;
    const text = Array.isArray(exec) ? exec.join("\n").trim() : "";
    if (!text) {
      continue;
    }
    if (ev.listen === "prerequest") {
      prerequest.push(text);
    } else if (ev.listen === "test") {
      test.push(text);
    }
  }
}

function collectPostmanScriptsFromCollection(raw: {
  item?: PostmanItem[];
  event?: PostmanEvent[];
}): {
  prerequest: string[];
  test: string[];
  signals: PostmanScriptSignals;
} {
  const prerequest: string[] = [];
  const test: string[] = [];
  pushEventScripts(raw.event, prerequest, test);
  walkPostmanItems(raw.item, (item) => {
    pushEventScripts(item.event, prerequest, test);
  });
  let signals: PostmanScriptSignals = {
    hasUuidLike: false,
    hasOAuthLike: false,
  };
  for (const s of [...prerequest, ...test]) {
    signals = mergePostmanScriptSignals(signals, detectPostmanScriptSignals(s));
  }
  return { prerequest, test, signals };
}

export class PostmanParser implements LegacyParserStrategy {
  readonly id = "postman";

  canHandle(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") {
      return false;
    }
    const o = raw as Record<string, unknown>;
    const schema = o.info && typeof o.info === "object" && (o.info as { schema?: string }).schema;
    if (typeof schema === "string" && schema.includes("getpostman.com")) {
      return true;
    }
    return Array.isArray(o.item) && o.item.length > 0;
  }

  parse(raw: unknown, options?: { serviceName?: string }): ParseResult {
    const losses: ParseResult["losses"] = [];
    const o = raw as {
      item?: PostmanItem[];
      info?: { name?: string };
      event?: PostmanEvent[];
    };
    const scripts = collectPostmanScriptsFromCollection(o);
    losses.push(
      ...buildPostmanScriptLosses(scripts.signals, {
        prerequest: scripts.prerequest.length,
        test: scripts.test.length,
      }),
    );

    const flat: { name: string; req: PostmanRequest }[] = [];
    collectItems(o.item, flat, "");

    const endpoints: EndpointDefinition[] = [];
    let i = 0;
    for (const { name, req } of flat) {
      const method = (req.method ?? "GET").toUpperCase();
      const path = urlToPath(req.url);
      const headers: Record<string, string> = {};
      for (const h of req.header ?? []) {
        if (h.key) {
          headers[h.key] = h.value ?? "";
        }
      }
      let body: unknown;
      if (req.body?.mode === "raw" && req.body.raw) {
        try {
          body = JSON.parse(req.body.raw) as unknown;
        } catch {
          body = req.body.raw;
        }
      }
      const id = `postman_${i++}_${sanitizeId(name)}`;
      endpoints.push({
        id,
        method: method as EndpointDefinition["method"],
        path,
        description: name,
        headers: Object.keys(headers).length ? headers : undefined,
        body,
      });
    }

    if (flat.some((x) => x.req.body?.mode && x.req.body.mode !== "raw")) {
      losses.push({
        code: "POSTMAN_BODY_MODE",
        message: "Non-raw body modes were not mapped in detail.",
      });
    }

    const canonical: ApiDefinitionYaml = {
      version: "1",
      service: options?.serviceName ?? o.info?.name ?? "imported-postman",
      base_url: "{{base_url}}",
      variables: { base_url: "" },
      endpoints,
    };

    return {
      canonical,
      losses,
      sourceLabel: "postman",
    };
  }
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "req";
}
