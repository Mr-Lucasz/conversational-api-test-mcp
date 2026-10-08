import { safeSliceString } from "./safeSlice.js";

export const REDACTED = "[REDACTED]";

const SENSITIVE_NAME =
  /(pass(word|wd)?|secret|token|authorization|api[-_]?key|cookie|session[-_]?id|credential|private[-_]?key|signature)/i;

/**
 * Usage figures of LLM APIs, not credentials: a number under `total_tokens` /
 * `token_count`, or the `*_tokens_details` breakdown. Deliberately narrow — a
 * `tokens: { access: … }` object is still a credential.
 */
const TOKEN_COUNT_NAME = /_tokens$|token_?count$/i;
const TOKEN_DETAILS_NAME = /_tokens_details$/i;

const JWT_LIKE = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

/** `MCP_API_REVEAL_SECRETS=true` turns masking off (local debugging only). */
export function secretsRevealed(): boolean {
  const v = process.env.MCP_API_REVEAL_SECRETS?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

/** Mask a named value when the name or the value itself looks like a credential. */
export function maskIfSensitive(name: string, value: string): string {
  if (secretsRevealed()) {
    return value;
  }
  return isSensitiveName(name) || JWT_LIKE.test(value) ? REDACTED : value;
}

export function maskRecord(
  record: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = maskIfSensitive(k, v);
  }
  return out;
}

export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    // CORS headers describe policy (`access-control-allow-credentials: true`), not secrets.
    out[k] = k.toLowerCase().startsWith("access-control-")
      ? v
      : maskIfSensitive(k, v);
  }
  return out;
}

function redactNode(
  value: unknown,
  forced: boolean,
  state: { changed: boolean },
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => redactNode(v, forced, state));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const usageFigure =
        (typeof v === "number" && TOKEN_COUNT_NAME.test(k)) ||
        (v !== null && typeof v === "object" && TOKEN_DETAILS_NAME.test(k));
      out[k] = redactNode(
        v,
        forced || (isSensitiveName(k) && !usageFigure),
        state,
      );
    }
    return out;
  }
  const secret =
    (forced && (typeof value === "string" || typeof value === "number")) ||
    (typeof value === "string" && JWT_LIKE.test(value));
  if (secret) {
    state.changed = true;
    return REDACTED;
  }
  return value;
}

/** Deep-redact values under credential-looking keys (and JWT-looking strings anywhere). */
export function redactJsonValue(value: unknown): {
  value: unknown;
  changed: boolean;
} {
  if (secretsRevealed()) {
    return { value, changed: false };
  }
  const state = { changed: false };
  return { value: redactNode(value, false, state), changed: state.changed };
}

/** Redact a JSON text; returns the input untouched when it is not JSON or has nothing to hide. */
export function redactJsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const r = redactJsonValue(parsed);
  return r.changed ? JSON.stringify(r.value) : text;
}

/** Redact credential-looking query parameters. */
export function redactUrl(url: string): string {
  if (secretsRevealed()) {
    return url;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    if (isSensitiveName(key)) {
      u.searchParams.set(key, "REDACTED");
      changed = true;
    }
  }
  return changed ? u.href : url;
}

export function truncateBody(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return safeSliceString(text, maxChars) + `\n… [truncated ${text.length - maxChars} chars]`;
}
