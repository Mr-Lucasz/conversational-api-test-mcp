import type { ApiDefinitionYaml, EndpointDefinition } from "../canonical/schema.js";
import {
  buildPostmanScriptLosses,
  detectPostmanScriptSignals,
  mergePostmanScriptSignals,
  type PostmanScriptSignals,
} from "./knownLosses.js";
import type { LegacyParserStrategy, ParseResult } from "./LegacyParserStrategy.js";
import {
  rewriteDynamicVariables,
  translatePreRequestScripts,
  translateTestScripts,
} from "./postmanScripts.js";

type PostmanEvent = {
  listen?: string;
  script?: { exec?: string[] };
};

type PostmanItem = {
  name?: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  event?: PostmanEvent[];
  auth?: PostmanAuth;
};

type PostmanKeyValue = { key?: string; value?: unknown; disabled?: boolean; type?: string };

type PostmanBody = {
  mode?: string;
  raw?: string;
  urlencoded?: PostmanKeyValue[];
  graphql?: { query?: string; variables?: unknown };
};

/**
 * Authorization tab. v2.1 stores each parameter as `[{ key, value }]`; v2.0 as a plain object.
 * `noauth` disables auth; `inherit` (or no `auth` at all) takes it from the folder or collection.
 */
type PostmanAuth = { type?: string } & Record<string, unknown>;

type PostmanRequest = {
  method?: string;
  header?: { key: string; value: string; disabled?: boolean }[];
  body?: PostmanBody;
  url?: PostmanUrl | string;
  auth?: PostmanAuth;
};

type PostmanUrl = {
  raw?: string;
  host?: string[];
  path?: string[];
  query?: { key: string; value?: string; disabled?: boolean }[];
};

type PostmanVariable = { key?: string; value?: unknown; disabled?: boolean };

const HOST_PLACEHOLDER = /^\{\{\s*([^}\s]+)\s*\}\}/;

/** Query string from the structured `query` list, or from `raw` when the list is absent. */
function urlQuery(url: PostmanUrl): string {
  if (url.query) {
    const pairs = url.query
      .filter((q) => q.key && !q.disabled)
      .map((q) => (q.value === undefined || q.value === null ? q.key : `${q.key}=${q.value}`));
    return pairs.length ? `?${pairs.join("&")}` : "";
  }
  const at = url.raw?.indexOf("?") ?? -1;
  return at >= 0 ? url.raw!.slice(at) : "";
}

/**
 * Base URL of the collection: the origin of the first absolute request URL, or the value of the
 * collection variable used as host (`{{baseUrl}}/posts`). Empty when neither is available.
 */
function resolveBaseUrl(requests: PostmanRequest[], variables: PostmanVariable[] | undefined): string {
  const values = new Map<string, string>();
  for (const v of variables ?? []) {
    if (v.key && !v.disabled && typeof v.value === "string" && v.value.trim()) {
      values.set(v.key, v.value.trim());
    }
  }
  for (const req of requests) {
    const raw = typeof req.url === "string" ? req.url : req.url?.raw;
    if (!raw) {
      continue;
    }
    const placeholder = HOST_PLACEHOLDER.exec(raw);
    if (placeholder) {
      const value = values.get(placeholder[1]);
      if (value) {
        return value.replace(/\/+$/, "");
      }
      continue;
    }
    try {
      return new URL(raw).origin;
    } catch {
      // relative URL: try the next request
    }
  }
  return "";
}

function urlToPath(url: PostmanUrl | string | undefined): string {
  if (!url) {
    return "/";
  }
  if (typeof url === "string") {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      const rest = url.replace(HOST_PLACEHOLDER, "");
      return rest.startsWith("/") ? rest : `/${rest}`;
    }
  }
  if (url.raw) {
    try {
      const u = new URL(url.raw);
      return u.pathname + u.search;
    } catch {
      const path = (url.path ?? []).join("/");
      return (path ? `/${path}` : "/") + urlQuery(url);
    }
  }
  const path = (url.path ?? []).join("/");
  return (path ? `/${path}` : "/") + urlQuery(url);
}

type FlatRequest = {
  name: string;
  req: PostmanRequest;
  auth: PostmanAuth | undefined;
  events: PostmanEvent[];
};

/** The auth that applies at this level: its own, unless absent or `inherit`. */
function effectiveAuth(
  own: PostmanAuth | undefined,
  inherited: PostmanAuth | undefined,
): PostmanAuth | undefined {
  return own?.type && own.type !== "inherit" ? own : inherited;
}

function collectItems(
  items: PostmanItem[] | undefined,
  out: FlatRequest[],
  prefix: string,
  inheritedAuth: PostmanAuth | undefined,
  inheritedEvents: PostmanEvent[],
): void {
  if (!items) {
    return;
  }
  for (const it of items) {
    const name = prefix ? `${prefix}/${it.name ?? "item"}` : (it.name ?? "item");
    const auth = effectiveAuth(it.auth, inheritedAuth);
    // Collection and folder scripts run around every request below them, before its own.
    const events = [...inheritedEvents, ...(it.event ?? [])];
    if (it.item?.length) {
      collectItems(it.item, out, name, auth, events);
    }
    if (it.request) {
      out.push({ name, req: it.request, auth: effectiveAuth(it.request.auth, auth), events });
    }
  }
}

function scriptsOf(events: PostmanEvent[], listen: "prerequest" | "test"): string[] {
  return events
    .filter((e) => e.listen === listen)
    .map((e) => (Array.isArray(e.script?.exec) ? e.script.exec.join("\n") : ""))
    .filter((t) => t.trim());
}

/** One auth parameter, from the v2.1 list form or the v2.0 object form. */
function authParam(auth: PostmanAuth, key: string): string | undefined {
  const params = auth[auth.type as string];
  let value: unknown;
  if (Array.isArray(params)) {
    value = (params as PostmanKeyValue[]).find((p) => p.key === key)?.value;
  } else if (params && typeof params === "object") {
    value = (params as Record<string, unknown>)[key];
  }
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

type MappedAuth = Pick<EndpointDefinition, "auth" | "digest_auth"> & {
  header?: [string, string];
  param?: [string, string];
};

/**
 * Canonical form of a Postman auth; nothing for `noauth` or an empty one.
 * `unsupported` names the type when there is no canonical equivalent.
 */
function mapAuth(auth: PostmanAuth | undefined): { mapped?: MappedAuth; unsupported?: string } {
  if (!auth?.type || auth.type === "noauth") {
    return {};
  }
  switch (auth.type) {
    case "bearer": {
      const token = authParam(auth, "token");
      return token ? { mapped: { auth: `Bearer ${token}` } } : {};
    }
    case "basic": {
      const username = authParam(auth, "username") ?? "";
      const password = authParam(auth, "password") ?? "";
      if (!username && !password) {
        return {};
      }
      if (`${username}${password}`.includes("{{")) {
        // Only known at run time, and `auth` is sent as written: there is no base64 step.
        return { unsupported: "basic with {{variables}}" };
      }
      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      return { mapped: { auth: `Basic ${encoded}` } };
    }
    case "digest": {
      const username = authParam(auth, "username");
      const password = authParam(auth, "password");
      return username && password ? { mapped: { digest_auth: { username, password } } } : {};
    }
    case "apikey": {
      const key = authParam(auth, "key");
      if (!key) {
        return {};
      }
      const value = authParam(auth, "value") ?? "";
      return authParam(auth, "in") === "query"
        ? { mapped: { param: [key, value] } }
        : { mapped: { header: [key, value] } };
    }
    default:
      return { unsupported: auth.type };
  }
}

/** `raw` → `body` (parsed when JSON), `urlencoded` → `form`, `graphql` → JSON `body`. */
function mapBody(
  body: PostmanBody | undefined,
): Pick<EndpointDefinition, "body" | "form"> & { unmapped?: string } {
  if (!body?.mode) {
    return {};
  }
  switch (body.mode) {
    case "raw":
      if (!body.raw) {
        return {};
      }
      try {
        return { body: JSON.parse(body.raw) as unknown };
      } catch {
        return { body: body.raw };
      }
    case "urlencoded": {
      const form: Record<string, string> = {};
      for (const p of body.urlencoded ?? []) {
        if (p.key && !p.disabled) {
          form[p.key] = p.value === undefined || p.value === null ? "" : String(p.value);
        }
      }
      return Object.keys(form).length ? { form } : {};
    }
    case "graphql": {
      const query = body.graphql?.query;
      if (!query) {
        return {};
      }
      let variables = body.graphql?.variables;
      if (typeof variables === "string") {
        try {
          variables = variables.trim() ? (JSON.parse(variables) as unknown) : undefined;
        } catch {
          // keep the text as Postman had it
        }
      }
      return { body: variables === undefined ? { query } : { query, variables } };
    }
    default:
      return { unmapped: body.mode };
  }
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
      variable?: PostmanVariable[];
      auth?: PostmanAuth;
    };
    // Hints in the script losses come only from the scripts that were not translated.
    let leftoverSignals: PostmanScriptSignals = { hasUuidLike: false, hasOAuthLike: false };
    const noteLeftover = (texts: string[]) => {
      for (const t of texts) {
        leftoverSignals = mergePostmanScriptSignals(leftoverSignals, detectPostmanScriptSignals(t));
      }
    };
    const untranslatedPre: string[] = [];
    const untranslatedTests: string[] = [];
    const generatedVariables: Record<string, string> = {};

    const flat: FlatRequest[] = [];
    collectItems(o.item, flat, "", effectiveAuth(o.auth, undefined), o.event ?? []);

    const endpoints: EndpointDefinition[] = [];
    const unmappedBodies = new Map<string, string[]>();
    const unsupportedAuth = new Map<string, string[]>();
    const note = (map: Map<string, string[]>, key: string, name: string) =>
      map.set(key, [...(map.get(key) ?? []), name]);
    let i = 0;
    for (const { name, req, auth, events } of flat) {
      const method = (req.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      for (const h of req.header ?? []) {
        if (h.key && !h.disabled) {
          headers[h.key] = h.value ?? "";
        }
      }
      const { unmapped, ...payload } = mapBody(req.body);
      if (unmapped) {
        note(unmappedBodies, unmapped, name);
      }
      const endpoint: EndpointDefinition = {
        id: `postman_${i++}_${sanitizeId(name)}`,
        method: method as EndpointDefinition["method"],
        path: urlToPath(req.url),
        description: name,
        ...payload,
      };

      // An Authorization header typed on the request wins over the Authorization tab.
      const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
      const { mapped, unsupported } = hasAuthHeader ? {} : mapAuth(auth);
      if (unsupported) {
        note(unsupportedAuth, unsupported, name);
      }
      if (mapped?.auth) {
        endpoint.auth = mapped.auth;
      }
      if (mapped?.digest_auth) {
        endpoint.digest_auth = mapped.digest_auth;
      }
      if (mapped?.header) {
        headers[mapped.header[0]] = mapped.header[1];
      }
      if (mapped?.param) {
        endpoint.params = { [mapped.param[0]]: mapped.param[1] };
      }
      if (Object.keys(headers).length) {
        endpoint.headers = headers;
      }
      const tests = translateTestScripts(scriptsOf(events, "test"));
      if (tests.assert) endpoint.assert = tests.assert;
      if (tests.capture) endpoint.capture = tests.capture;
      if (tests.unconverted) {
        untranslatedTests.push(name);
        noteLeftover(tests.leftover);
      }
      const pre = translatePreRequestScripts(scriptsOf(events, "prerequest"));
      for (const [k, v] of Object.entries(pre.variables ?? {})) generatedVariables[k] ??= v;
      if (pre.unconverted) {
        untranslatedPre.push(name);
        noteLeftover(pre.leftover);
      }
      endpoints.push(rewriteDynamicVariables(endpoint));
    }

    losses.push(
      ...buildPostmanScriptLosses(leftoverSignals, {
        prerequest: untranslatedPre.length,
        test: untranslatedTests.length,
      }).map((l) => ({
        ...l,
        message: `${l.message} Requests: ${(l.code === "POSTMAN_TESTS" ? untranslatedTests : untranslatedPre).join(", ")}.`,
      })),
    );
    for (const [mode, names] of unmappedBodies) {
      losses.push({
        code: "POSTMAN_BODY_MODE",
        message: `Body mode "${mode}" is not mapped; rewrite it as body or form: ${names.join(", ")}.`,
      });
    }
    for (const [type, names] of unsupportedAuth) {
      losses.push({
        code: "POSTMAN_AUTH_UNSUPPORTED",
        message: `Authorization "${type}" is not converted; set auth (or capture + auth_dependency) by hand: ${names.join(", ")}.`,
      });
    }

    const baseUrl = resolveBaseUrl(
      flat.map((x) => x.req),
      o.variable,
    );
    if (!baseUrl && flat.length) {
      losses.push({
        code: "POSTMAN_BASE_URL_UNRESOLVED",
        message:
          "No absolute URL or collection variable with the host was found; set base_url before running.",
      });
    }

    const canonical: ApiDefinitionYaml = {
      version: "1",
      service: options?.serviceName ?? o.info?.name ?? "imported-postman",
      base_url: "{{base_url}}",
      variables: { base_url: baseUrl, ...generatedVariables },
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
