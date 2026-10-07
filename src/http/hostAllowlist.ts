/**
 * Optional host allowlist — not a full SSRF defence. When `MCP_API_ALLOWED_HOSTS`
 * (comma-separated hostnames) is set, requests and every redirect hop must target
 * one of those hosts. Unset / empty = any host is allowed (local dev default).
 */
function allowedHosts(): Set<string> | null {
  const raw = process.env.MCP_API_ALLOWED_HOSTS?.trim();
  if (!raw) {
    return null;
  }
  return new Set(
    raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  );
}

export function isHostAllowlistActive(): boolean {
  return allowedHosts() !== null;
}

export function isUrlAllowed(urlString: string): boolean {
  const allowed = allowedHosts();
  if (!allowed) {
    return true;
  }
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  return allowed.has(u.hostname.toLowerCase());
}
