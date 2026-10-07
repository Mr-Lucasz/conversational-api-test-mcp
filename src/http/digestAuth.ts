import { createHash, randomBytes } from "node:crypto";

export type DigestChallenge = {
  realm: string;
  nonce: string;
  opaque?: string;
  qop?: string;
  algorithm?: string;
};

function md5Hex(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/** Path + query for Digest `uri` (RFC 2617 style). */
export function digestUriFromUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return `${u.pathname}${u.search}`;
  } catch {
    return "/";
  }
}

/**
 * Parse first `Digest ...` challenge from WWW-Authenticate header value.
 */
export function parseDigestParams(wwwAuthenticate: string): DigestChallenge | null {
  const m = /Digest\s+(.+)/i.exec(wwwAuthenticate.trim());
  if (!m?.[1]) {
    return null;
  }
  const body = m[1];
  const pairs: Record<string, string> = {};
  const re = /(\w+)=("([^"]*)"|([^\s,]+))/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(body)) !== null) {
    const key = mm[1].toLowerCase();
    const val = mm[3] ?? mm[4] ?? "";
    pairs[key] = val;
  }
  const realm = pairs.realm;
  const nonce = pairs.nonce;
  if (!realm || !nonce) {
    return null;
  }
  return {
    realm,
    nonce,
    opaque: pairs.opaque,
    qop: pairs.qop,
    algorithm: pairs.algorithm,
  };
}

function pickQop(challenge: DigestChallenge): "auth" | null {
  const q = (challenge.qop ?? "").toLowerCase();
  if (q.includes("auth")) {
    return "auth";
  }
  if (!q) {
    return null;
  }
  return null;
}

export function buildDigestAuthorizationHeader(args: {
  method: string;
  digestUri: string;
  username: string;
  password: string;
  challenge: DigestChallenge;
}): string {
  const { method, digestUri, username, password, challenge } = args;
  const realm = challenge.realm;
  const nonce = challenge.nonce;
  const algo = (challenge.algorithm ?? "MD5").toUpperCase();
  if (algo !== "MD5") {
    throw new Error(`digest_auth: unsupported algorithm ${challenge.algorithm}`);
  }

  const ha1 = md5Hex(`${username}:${realm}:${password}`);
  const ha2 = md5Hex(`${method.toUpperCase()}:${digestUri}`);

  const qop = pickQop(challenge);
  let response: string;
  let qopSegment = "";

  if (qop === "auth") {
    const cnonce = randomBytes(8).toString("hex");
    const nc = "00000001";
    response = md5Hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    qopSegment = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else if (!challenge.qop) {
    response = md5Hex(`${ha1}:${nonce}:${ha2}`);
  } else {
    throw new Error(`digest_auth: unsupported qop ${challenge.qop}`);
  }

  const bits: string[] = [
    `username="${escapeDigestQuoted(username)}"`,
    `realm="${escapeDigestQuoted(realm)}"`,
    `nonce="${escapeDigestQuoted(nonce)}"`,
    `uri="${escapeDigestQuoted(digestUri)}"`,
    `response="${response}"`,
    `algorithm=${algo}`,
  ];
  if (challenge.opaque) {
    bits.push(`opaque="${escapeDigestQuoted(challenge.opaque)}"`);
  }
  if (qopSegment) {
    bits.push(qopSegment.slice(2));
  }
  return `Digest ${bits.join(", ")}`;
}

function escapeDigestQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
