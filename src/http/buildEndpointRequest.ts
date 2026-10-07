import type { EndpointDefinition } from "../canonical/schema.js";
import {
  interpolateString,
  interpolateUnknown,
  type InterpolationContext,
} from "./VariableInterpolator.js";

/**
 * Interpolated headers (including Bearer `Authorization` when `auth` is set and not Digest).
 * Serialized body for `form` or `body`, with default Content-Type when missing.
 */
export function buildEndpointHeadersAndBody(
  ep: EndpointDefinition,
  ctx: InterpolationContext,
): { headers: Record<string, string>; body: string | undefined } {
  const headers: Record<string, string> = {
    ...(ep.headers
      ? (interpolateUnknown(ep.headers, ctx) as Record<string, string>)
      : {}),
  };
  if (ep.auth && !ep.digest_auth) {
    headers.Authorization = interpolateString(ep.auth, ctx);
  }

  let body: string | undefined;
  if (ep.form !== undefined) {
    const flat = interpolateUnknown(ep.form, ctx) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(flat)) {
      let s: string;
      if (v == null) {
        s = "";
      } else if (typeof v === "string") {
        s = v;
      } else if (typeof v === "object") {
        s = JSON.stringify(v);
      } else {
        s = String(v);
      }
      params.set(k, s);
    }
    body = params.toString();
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
  } else if (ep.body !== undefined) {
    const b = interpolateUnknown(ep.body, ctx);
    body = typeof b === "string" ? b : JSON.stringify(b);
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  return { headers, body };
}
