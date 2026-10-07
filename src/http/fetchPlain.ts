import type { EndpointDefinition } from "../canonical/schema.js";
import { isHostAllowlistActive, isUrlAllowed } from "./hostAllowlist.js";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type FetchInput = {
  url: string;
  method: EndpointDefinition["method"];
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal;
};

function dropHeaders(
  headers: Record<string, string>,
  names: string[],
): Record<string, string> {
  const drop = new Set(names);
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())),
  );
}

/**
 * `fetch` that keeps the host allowlist honest across redirects. Without an
 * allowlist it is a plain `fetch`; with one, redirects are followed manually so
 * each hop is checked before any request is sent to it.
 */
export async function fetchPlain(input: FetchInput): Promise<Response> {
  const { url, signal } = input;
  let method: string = input.method;
  let headers = input.headers;
  let body =
    method === "GET" || method === "HEAD" ? undefined : input.body;

  if (!isHostAllowlistActive()) {
    return fetch(url, { method, headers, body, signal });
  }

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      method,
      headers,
      body,
      signal,
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || !location) {
      return res;
    }
    const next = new URL(location, current);
    if (!isUrlAllowed(next.href)) {
      throw new Error(
        `redirect to host not allowed by MCP_API_ALLOWED_HOSTS: ${next.host}`,
      );
    }
    await res.body?.cancel().catch(() => undefined);

    const downgradeToGet =
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method === "POST");
    if (downgradeToGet) {
      method = "GET";
      body = undefined;
      headers = dropHeaders(headers, ["content-type", "content-length"]);
    }
    if (next.origin !== new URL(current).origin) {
      headers = dropHeaders(headers, ["authorization", "cookie"]);
    }
    current = next.href;
  }
  throw new Error(`too many redirects (max ${MAX_REDIRECTS})`);
}

function maxResponseBytes(): number {
  const n = Number(process.env.MCP_API_MAX_RESPONSE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RESPONSE_BYTES;
}

/**
 * Read the response body as text, failing once it exceeds the size cap
 * (`MCP_API_MAX_RESPONSE_BYTES`, default 10 MB) instead of buffering it all.
 */
export async function readBodyTextCapped(res: Response): Promise<string> {
  if (!res.body) {
    return "";
  }
  const limit = maxResponseBytes();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(
        `response body exceeds ${limit} bytes (MCP_API_MAX_RESPONSE_BYTES)`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
