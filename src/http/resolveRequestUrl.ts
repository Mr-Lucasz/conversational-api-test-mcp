import { isUrlAllowed } from "./hostAllowlist.js";

/**
 * Join `baseUrl` and `path` by concatenation, so a path prefix in the base
 * (`https://host/api/v1` + `/users`) is preserved. An absolute `path` wins.
 */
export function resolveUrl(baseUrl: string, path: string): string {
  const p = path.trim();
  if (p.startsWith("http://") || p.startsWith("https://")) {
    return p;
  }
  const base = baseUrl.trim().replace(/\/+$/, "");
  const rel = p.startsWith("/") ? p : `/${p}`;
  const joined = base + rel;
  try {
    return new URL(joined).href;
  } catch {
    return joined;
  }
}

function appendQueryParams(
  url: string,
  params: Record<string, string> | undefined,
): string {
  if (!params || Object.keys(params).length === 0) {
    return url;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.append(k, v);
  }
  return u.href;
}

/** Resolves base + path (+ endpoint `params` as query string) and enforces the optional host allowlist. */
export function resolveRequestUrl(
  baseUrl: string,
  pathInterpolated: string,
  params?: Record<string, string>,
): { ok: true; url: string } | { ok: false; message: string } {
  const url = appendQueryParams(resolveUrl(baseUrl, pathInterpolated), params);
  if (!isUrlAllowed(url)) {
    return {
      ok: false,
      message: `URL host not allowed by MCP_API_ALLOWED_HOSTS: ${url}`,
    };
  }
  return { ok: true, url };
}
