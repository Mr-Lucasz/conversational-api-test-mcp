import { z } from "zod";
import { readApiDefinitionFile } from "../canonical/io.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspaceRoot.js";
import {
  buildInterpolationContext,
  interpolateString,
  interpolateUnknown,
} from "../http/VariableInterpolator.js";
import { buildEndpointHeadersAndBody } from "../http/buildEndpointRequest.js";
import { resolveRequestUrl } from "../http/resolveRequestUrl.js";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import { getSession } from "../session/SessionStore.js";
import {
  REDACTED,
  isSensitiveName,
  redactHeaders,
  redactJsonValue,
  redactUrl,
  secretsRevealed,
  truncateBody,
} from "../http/redact.js";
import { safeTool, textResult } from "./toolResult.js";

function redactBody(body: string): string {
  if (secretsRevealed()) {
    return body;
  }
  try {
    return JSON.stringify(redactJsonValue(JSON.parse(body)).value);
  } catch {
    // not JSON: fall through to form / free-text handling
  }

  // URL-encoded (form): key=value&key=value
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)) {
    return body.replace(
      /(^|&)([^=&]+)=([^&]*)/g,
      (full, prefix: string, rawKey: string) =>
        isSensitiveName(rawKey) ? `${prefix}${rawKey}=${REDACTED}` : full,
    );
  }

  // Free text: redact values right after common credential keys.
  return body.replace(
    /(client_secret|password|token|access_token|refresh_token|authorization)\s*[:=]\s*([^\s,}&"]+)/gi,
    (_m, key: string) => `${key}: ${REDACTED}`,
  );
}

export const dryRunRequestInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Optional when MCP_WORKSPACE_ROOT is set."),
  definitionRelativePath: z.string(),
  requestId: z.string(),
  maxBodyChars: z.number().int().positive().optional().default(8000),
});

export async function dryRunRequestHandler(
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const parsed = dryRunRequestInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult({ error: parsed.error.flatten() }, true);
  }

  return safeTool(async () => {
    const workspaceRoot = resolveWorkspaceRoot(parsed.data.workspaceRoot);
    const filePath = safeResolveUnderWorkspace(
      workspaceRoot,
      parsed.data.definitionRelativePath,
    );

    const def = readApiDefinitionFile(filePath);
    const ep = def.endpoints.find((e) => e.id === parsed.data.requestId);
    if (!ep) {
      throw new Error(`Unknown request id: ${parsed.data.requestId}`);
    }

    const envLocal = loadEnvMcpLocalParsed(workspaceRoot);
    const session = getSession(workspaceRoot);

    const ctx = buildInterpolationContext(def.variables, envLocal, session.variables);

    const baseUrl = interpolateString(def.base_url ?? "{{base_url}}", ctx);
    const pathInterpolated = interpolateString(ep.path, ctx);
    const urlResult = resolveRequestUrl(
      baseUrl,
      pathInterpolated,
      ep.params
        ? (interpolateUnknown(ep.params, ctx) as Record<string, string>)
        : undefined,
    );
    if (!urlResult.ok) {
      throw new Error(urlResult.message);
    }

    const { headers, body } = buildEndpointHeadersAndBody(ep, ctx);
    const redactedHeaders = redactHeaders(headers);

    const bodyStr = body ?? "";
    const bodyRedacted = bodyStr ? redactBody(bodyStr) : "";
    const bodyPreviewTruncated = bodyRedacted.length > parsed.data.maxBodyChars;
    const bodyPreview = truncateBody(
      bodyRedacted,
      parsed.data.maxBodyChars,
    );

    return {
      ok: true,
      url: redactUrl(urlResult.url),
      method: ep.method,
      requestHeaders: redactedHeaders,
      bodyLength: bodyRedacted.length,
      bodyPreview,
      bodyPreviewTruncated,
      authDependency: ep.auth_dependency ?? null,
      auth: ep.auth ?? null,
      // Templates (`{{VAR}}`) são seguros de mostrar; senha literal no YAML não.
      digestAuth: ep.digest_auth
        ? {
            username: ep.digest_auth.username,
            password:
              ep.digest_auth.password.includes("{{") || secretsRevealed()
                ? ep.digest_auth.password
                : REDACTED,
          }
        : null,
    };
  });
}

