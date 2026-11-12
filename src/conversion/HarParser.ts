import type { ApiDefinitionYaml, EndpointDefinition } from "../canonical/schema.js";
import { isSensitiveName } from "../http/redact.js";
import type { LegacyParserStrategy, ParseOptions, ParseResult } from "./LegacyParserStrategy.js";

/**
 * HAR (HTTP Archive), what the browser DevTools "Save all as HAR" and most proxies export:
 * the API calls a real session made, in order. Each distinct method + path becomes an
 * endpoint (with the status it got as its assert) and the recording becomes a flow.
 * Credentials are never copied: Authorization and Cookie become placeholders.
 */

type HarHeader = { name: string; value: string };
type HarEntry = {
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    postData?: { mimeType?: string; text?: string; params?: Array<{ name: string; value?: string }> };
  };
  response?: { status?: number; content?: { mimeType?: string } };
};

const STATIC_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|html?)$/i;
const STATIC_MIME = /^(image|font|audio|video)\/|text\/(css|html|javascript)|application\/(javascript|x-javascript)/i;
/** Headers the browser adds on its own; they say nothing about the API. */
const BROWSER_HEADER =
  /^(:|host$|connection$|content-length$|accept-encoding$|accept-language$|user-agent$|referer$|origin$|sec-|pragma$|cache-control$|priority$|dnt$|upgrade-insecure-requests$)/i;
const MAX_FLOW_STEPS = 50;

function slug(method: string, path: string): string {
  const s = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .slice(0, 50);
  return `${method.toLowerCase()}_${s || "root"}`;
}

export class HarParser implements LegacyParserStrategy {
  readonly id = "har";

  canHandle(raw: unknown): boolean {
    const log = (raw as { log?: { entries?: unknown } } | null)?.log;
    return Boolean(log && Array.isArray(log.entries));
  }

  parse(raw: unknown, options?: ParseOptions): ParseResult {
    const entries = ((raw as { log: { entries: HarEntry[] } }).log.entries ?? []).filter((e) => {
      const url = e.request?.url ?? "";
      if (!/^https?:\/\//i.test(url)) return false;
      const path = url.replace(/[?#].*$/, "");
      const mime = e.response?.content?.mimeType ?? "";
      return !(STATIC_EXT.test(path) || (STATIC_MIME.test(mime) && (e.request?.method ?? "GET") === "GET"));
    });

    const origins = new Map<string, number>();
    for (const e of entries) {
      const o = new URL(e.request!.url!).origin;
      origins.set(o, (origins.get(o) ?? 0) + 1);
    }
    const baseUrl = [...origins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

    const endpoints: EndpointDefinition[] = [];
    const byKey = new Map<string, string>();
    const flowSteps: string[] = [];
    let otherOrigin = 0;
    let usedAuth = false;
    let usedCookie = false;

    for (const e of entries) {
      const req = e.request!;
      const url = new URL(req.url!);
      if (url.origin !== baseUrl) {
        otherOrigin++;
        continue;
      }
      const method = (req.method ?? "GET").toUpperCase() as EndpointDefinition["method"];
      const key = `${method} ${url.pathname}`;
      let id = byKey.get(key);
      if (!id) {
        id = slug(method, url.pathname);
        while (endpoints.some((x) => x.id === id)) id = `${id}_2`;
        byKey.set(key, id);
        const ep: EndpointDefinition = { id, method, path: url.pathname };
        const params = Object.fromEntries(url.searchParams.entries());
        if (Object.keys(params).length) ep.params = params;

        const headers: Record<string, string> = {};
        for (const h of req.headers ?? []) {
          const name = h.name.toLowerCase();
          if (name === "authorization") {
            ep.auth = "{{AUTHORIZATION}}";
            usedAuth = true;
          } else if (name === "cookie") {
            headers.Cookie = "{{COOKIE}}";
            usedCookie = true;
          } else if (!BROWSER_HEADER.test(name) && !isSensitiveName(name)) {
            headers[h.name] = h.value;
          }
        }
        const post = req.postData;
        if (post?.params?.length || /x-www-form-urlencoded/i.test(post?.mimeType ?? "")) {
          ep.form = Object.fromEntries(
            post?.params?.length
              ? post.params.map((p) => [p.name, p.value ?? ""])
              : [...new URLSearchParams(post?.text ?? "").entries()],
          );
          delete headers["content-type"];
          delete headers["Content-Type"];
        } else if (post?.text) {
          try {
            ep.body = JSON.parse(post.text) as unknown;
            for (const k of Object.keys(headers)) {
              if (k.toLowerCase() === "content-type" && /json/i.test(headers[k] ?? "")) delete headers[k];
            }
          } catch {
            ep.body = post.text;
          }
        }
        if (Object.keys(headers).length) ep.headers = headers;
        if (e.response?.status) ep.assert = { status: e.response.status };
        endpoints.push(ep);
      }
      if (flowSteps.length < MAX_FLOW_STEPS) flowSteps.push(id);
    }

    const losses: ParseResult["losses"] = [];
    if (usedAuth || usedCookie) {
      losses.push({
        code: "HAR_AUTH",
        message: `Recorded credentials were not copied: set ${[usedAuth && "AUTHORIZATION (the whole header value, e.g. \"Bearer …\")", usedCookie && "COOKIE"].filter(Boolean).join(" and ")} in .env.mcp.local, or point the requests at a login endpoint with auth_dependency.`,
      });
    }
    if (otherOrigin) {
      losses.push({
        code: "HAR_OTHER_ORIGINS",
        message: `${otherOrigin} calls to other hosts (analytics, CDNs, third parties) were left out; only ${baseUrl} was kept.`,
      });
    }

    const canonical: ApiDefinitionYaml = {
      version: "1",
      service: options?.serviceName ?? new URL(baseUrl || "http://recorded").hostname,
      base_url: "{{base_url}}",
      variables: { base_url: baseUrl },
      endpoints,
      ...(flowSteps.length ? { flows: { recorded: { description: "The calls in the order the HAR recorded them", steps: flowSteps } } } : {}),
    };
    return { canonical, losses, sourceLabel: "har" };
  }
}
