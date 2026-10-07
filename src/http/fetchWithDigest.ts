import type { EndpointDefinition } from "../canonical/schema.js";
import {
  buildDigestAuthorizationHeader,
  digestUriFromUrl,
  parseDigestParams,
} from "./digestAuth.js";
import { fetchPlain } from "./fetchPlain.js";
import {
  interpolateString,
  type InterpolationContext,
} from "./VariableInterpolator.js";

type FetchOutcome =
  | { ok: true; response: Response }
  | { ok: false; message: string };

/**
 * HTTP Digest (RFC 2617): optional first hop without Authorization, then 401 + WWW-Authenticate retry.
 */
export async function fetchWithDigestAuth(input: {
  ep: EndpointDefinition;
  ctx: InterpolationContext;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal;
}): Promise<FetchOutcome> {
  const { ep, ctx, url, headers, body, signal } = input;
  const digest = ep.digest_auth;
  if (!digest) {
    return {
      ok: false,
      message: "fetchWithDigestAuth: endpoint has no digest_auth",
    };
  }
  const username = interpolateString(digest.username, ctx);
  const password = interpolateString(digest.password, ctx);
  if (!username.trim() || !password) {
    return {
      ok: false,
      message:
        "digest_auth: username and password must be non-empty after interpolation (e.g. DIGEST_USER / DIGEST_PASSWORD in .env.mcp.local)",
    };
  }

  const fetchOnce = (h: Record<string, string>) =>
    fetchPlain({ url, method: ep.method, headers: h, body, signal });

  let res = await fetchOnce(headers);

  if (res.status === 401) {
    const www =
      res.headers.get("www-authenticate") ??
      res.headers.get("WWW-Authenticate");
    await res.text().catch(() => undefined);

    if (!www) {
      return {
        ok: false,
        message:
          "digest_auth: server returned 401 without WWW-Authenticate header",
      };
    }

    const digestChallenge = parseDigestParams(www);
    if (!digestChallenge) {
      return {
        ok: false,
        message: `digest_auth: 401 but no Digest challenge in WWW-Authenticate (preview: ${www.slice(0, 240)})`,
      };
    }

    let authHeader: string;
    try {
      authHeader = buildDigestAuthorizationHeader({
        method: ep.method,
        digestUri: digestUriFromUrl(url),
        username,
        password,
        challenge: digestChallenge,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `digest_auth: ${msg}` };
    }

    const headersWithDigest: Record<string, string> = {
      ...headers,
      Authorization: authHeader,
    };
    res = await fetchOnce(headersWithDigest);
  }

  return { ok: true, response: res };
}
