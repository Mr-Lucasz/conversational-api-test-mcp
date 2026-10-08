import type { EndpointDefinition } from "../canonical/schema.js";
import { isSensitiveName } from "../http/redact.js";

/** Flags that consume the next token. Anything else starting with `-` is a switch. */
const VALUE_FLAGS = new Set([
  "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw",
  "--data-binary", "--data-ascii", "--data-urlencode", "--json", "-u", "--user",
  "-b", "--cookie", "-A", "--user-agent", "-e", "--referer", "--url",
  "-F", "--form", "-o", "--output", "-m", "--max-time", "--connect-timeout",
  "-x", "--proxy", "--cacert", "--cert", "--key", "-w", "--write-out",
  "--retry", "-c", "--cookie-jar", "-T", "--upload-file",
]);
const DATA_FLAGS = new Set([
  "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode",
]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export type ParsedCurl = {
  /** scheme://host[:port] */
  origin: string;
  endpoint: Omit<EndpointDefinition, "id">;
  /** Credential values lifted out of the request: variable name → real value. */
  secrets: Record<string, string>;
  /** Things in the command that were not carried over. */
  losses: string[];
};

/** Split a shell command line into arguments (single, double and `$'…'` quotes, `\` continuations). */
export function tokenizeShell(input: string): string[] {
  const src = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === "'" || (ch === "$" && src[i + 1] === "'")) {
      const ansi = ch === "$";
      i += ansi ? 2 : 1;
      started = true;
      while (i < src.length && src[i] !== "'") {
        if (ansi && src[i] === "\\" && i + 1 < src.length) {
          const next = src[i + 1] as string;
          current += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
        } else {
          current += src[i];
          i += 1;
        }
      }
      i += 1;
    } else if (ch === '"') {
      i += 1;
      started = true;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length && /["\\$`]/.test(src[i + 1] as string)) {
          current += src[i + 1];
          i += 2;
        } else {
          current += src[i];
          i += 1;
        }
      }
      i += 1;
    } else if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      i += 1;
    } else if (ch === "\\" && i + 1 < src.length) {
      current += src[i + 1];
      started = true;
      i += 2;
    } else {
      current += ch;
      started = true;
      i += 1;
    }
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

function variableName(prefix: string, name: string): string {
  return `${prefix}_${name}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Turn a `curl` command into an endpoint. Credentials (auth headers, cookies, `-u`,
 * credential-looking JSON / form / query fields) are replaced by `{{VARIABLE}}` and
 * returned separately so the caller can store them outside the definition.
 */
export function parseCurl(command: string, secretPrefix: string): ParsedCurl {
  const tokens = tokenizeShell(command.trim());
  if (tokens[0]?.toLowerCase().replace(/\.exe$/, "") !== "curl") {
    throw new Error("not a curl command (it must start with `curl`)");
  }

  let method: string | undefined;
  let url: string | undefined;
  let forceGet = false;
  let jsonFlag = false;
  const headers: Record<string, string> = {};
  const data: string[] = [];
  const losses: string[] = [];
  const secrets: Record<string, string> = {};
  const lift = (name: string, value: string): string => {
    const key = variableName(secretPrefix, name);
    secrets[key] = value;
    return `{{${key}}}`;
  };

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    if (!tok.startsWith("-") || tok === "-") {
      url ??= tok;
      continue;
    }
    if (tok === "-G" || tok === "--get") {
      forceGet = true;
      continue;
    }
    if (!VALUE_FLAGS.has(tok)) {
      continue; // switches such as -s, -L, -k, --compressed do not change the request
    }
    const value = tokens[++i];
    if (value === undefined) {
      throw new Error(`curl flag ${tok} is missing its value`);
    }
    if (tok === "-X" || tok === "--request") {
      method = value.toUpperCase();
    } else if (tok === "--url") {
      url = value;
    } else if (tok === "-H" || tok === "--header") {
      const idx = value.indexOf(":");
      if (idx > 0) {
        headers[value.slice(0, idx).trim()] = value.slice(idx + 1).trim();
      }
    } else if (tok === "--json") {
      jsonFlag = true;
      data.push(value);
    } else if (DATA_FLAGS.has(tok)) {
      data.push(value);
    } else if (tok === "-u" || tok === "--user") {
      headers.Authorization = `Basic ${Buffer.from(value).toString("base64")}`;
    } else if (tok === "-b" || tok === "--cookie") {
      headers.Cookie = value;
    } else if (tok === "-A" || tok === "--user-agent") {
      headers["User-Agent"] = value;
    } else if (tok === "-e" || tok === "--referer") {
      headers.Referer = value;
    } else if (tok === "-F" || tok === "--form" || tok === "-T" || tok === "--upload-file") {
      losses.push(`${tok} (multipart / file upload) is not supported and was dropped`);
    }
  }

  if (!url) {
    throw new Error("no URL found in the curl command");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    throw new Error(`could not parse the URL: ${url}`);
  }

  const bodyText = data.length ? data.join("&") : undefined;
  const finalMethod = (
    method ?? (forceGet || bodyText === undefined ? "GET" : "POST")
  ).toUpperCase();
  if (!METHODS.has(finalMethod)) {
    throw new Error(`unsupported HTTP method: ${finalMethod}`);
  }

  const params: Record<string, string> = {};
  parsedUrl.searchParams.forEach((v, k) => {
    params[k] = isSensitiveName(k) ? lift(k, v) : v;
  });
  if (forceGet && bodyText) {
    new URLSearchParams(bodyText).forEach((v, k) => {
      params[k] = isSensitiveName(k) ? lift(k, v) : v;
    });
  }

  const outHeaders: Record<string, string> = {};
  let auth: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization") {
      const scheme = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(value);
      auth = scheme
        ? `${scheme[1]} ${lift(scheme[1] === "Basic" ? "BASIC_AUTH" : "TOKEN", scheme[2] as string)}`
        : lift("AUTHORIZATION", value);
    } else if (lower === "content-length" || lower === "host") {
      continue; // recomputed by the HTTP client
    } else {
      outHeaders[name] = isSensitiveName(name) ? lift(name, value) : value;
    }
  }

  const endpoint: Omit<EndpointDefinition, "id"> = {
    method: finalMethod as EndpointDefinition["method"],
    path: decodeURI(parsedUrl.pathname) || "/",
    ...(Object.keys(params).length ? { params } : {}),
    ...(Object.keys(outHeaders).length ? { headers: outHeaders } : {}),
    ...(auth ? { auth } : {}),
  };

  if (bodyText !== undefined && !forceGet) {
    const contentType =
      Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = undefined;
    }
    const isObject = json !== null && typeof json === "object" && !Array.isArray(json);
    if (isObject && (jsonFlag || !/x-www-form-urlencoded/i.test(contentType))) {
      endpoint.body = Object.fromEntries(
        Object.entries(json as Record<string, unknown>).map(([k, v]) => [
          k,
          isSensitiveName(k) && typeof v === "string" ? lift(k, v) : v,
        ]),
      );
    } else if (json === undefined && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(bodyText)) {
      const form: Record<string, string> = {};
      new URLSearchParams(bodyText).forEach((v, k) => {
        form[k] = isSensitiveName(k) ? lift(k, v) : v;
      });
      endpoint.form = form;
      for (const k of Object.keys(outHeaders)) {
        if (k.toLowerCase() === "content-type") {
          delete outHeaders[k];
        }
      }
      if (Object.keys(outHeaders).length === 0) {
        delete endpoint.headers;
      }
    } else {
      endpoint.body = json ?? bodyText;
    }
  }

  return { origin: parsedUrl.origin, endpoint, secrets, losses };
}
