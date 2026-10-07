import { readApiDefinitionFile } from "../canonical/io.js";
import type {
  ApiDefinitionYaml,
  EndpointDefinition,
} from "../canonical/schema.js";
import {
  buildInterpolationContext,
  interpolateString,
  interpolateUnknown,
} from "./VariableInterpolator.js";
import { completeSuccessfulExecution } from "./completeSuccessfulExecution.js";
import { buildEndpointHeadersAndBody } from "./buildEndpointRequest.js";
import { fetchPlain, readBodyTextCapped } from "./fetchPlain.js";
import { fetchWithDigestAuth } from "./fetchWithDigest.js";
import { resolveRequestUrl } from "./resolveRequestUrl.js";
import { deleteSessionVariables, getSession } from "../session/SessionStore.js";
import { loadEnvMcpLocalParsed } from "../env/loadEnvMcpLocal.js";
import { safeResolveUnderWorkspace } from "../workspace/paths.js";
import type { ExecuteResult } from "./executeTypes.js";

export type { ExecuteResult } from "./executeTypes.js";

const DEFAULT_TIMEOUT = 30_000;

export type ExecuteOutputOptions = {
  responseDetail?: "minimal" | "summary" | "full";
  jsonPathSelect?: string;
  maxBodyChars?: number;
};

function findEndpoint(
  def: ApiDefinitionYaml,
  id: string,
): EndpointDefinition | undefined {
  return def.endpoints.find((e) => e.id === id);
}

/** Run `auth_dependency` when session lacks captured vars from that endpoint. */
async function ensureAuthDependencySession(
  input: {
    workspaceRoot: string;
    def: ApiDefinitionYaml;
    envLocal: Record<string, string>;
    ep: EndpointDefinition;
    requestId: string;
    chain: string[];
    timeoutMs: number;
    outputOptions: ExecuteOutputOptions;
  },
): Promise<ExecuteResult | null> {
  const {
    workspaceRoot,
    def,
    envLocal,
    ep,
    requestId,
    chain,
    timeoutMs,
    outputOptions,
  } = input;
  if (!ep.auth_dependency) {
    return null;
  }
  const authEp = findEndpoint(def, ep.auth_dependency);
  if (!authEp) {
    return {
      ok: false,
      message: `auth_dependency: unknown endpoint id "${ep.auth_dependency}"`,
    };
  }
  const requiredKeys = Object.keys(authEp.capture ?? {});
  const session = getSession(workspaceRoot);
  const missing = requiredKeys.filter((k) => !session.variables[k]);
  if (missing.length === 0) {
    return null;
  }
  const sub = await runEndpointWithDefinition({
    workspaceRoot,
    def,
    envLocal,
    requestId: ep.auth_dependency,
    timeoutMs,
    chain: [...chain, requestId],
    allow401Retry: true,
    outputOptions,
  });
  return sub.ok ? null : sub;
}

/** On 401 with bearer refresh, clear token capture and retry the request once. */
async function refreshAuthAndRetryRequest(input: {
  workspaceRoot: string;
  def: ApiDefinitionYaml;
  envLocal: Record<string, string>;
  ep: EndpointDefinition;
  requestId: string;
  chain: string[];
  timeoutMs: number;
  firstResult: ExecuteResult;
  outputOptions: ExecuteOutputOptions;
}): Promise<ExecuteResult> {
  const {
    workspaceRoot,
    def,
    envLocal,
    ep,
    requestId,
    chain,
    timeoutMs,
    firstResult,
    outputOptions,
  } = input;

  // `status` também vem preenchido quando o `assert` do endpoint falhou sobre um 401.
  const authRetry =
    ep.auth_retry_on_401 !== false &&
    Boolean(ep.auth_dependency) &&
    firstResult.status === 401;

  if (!authRetry || !ep.auth_dependency) {
    return firstResult;
  }

  const authEp = findEndpoint(def, ep.auth_dependency);
  if (!authEp) {
    return firstResult;
  }

  const keys = Object.keys(authEp.capture ?? {});
  deleteSessionVariables(workspaceRoot, keys);
  const refresh = await runEndpointWithDefinition({
    workspaceRoot,
    def,
    envLocal,
    requestId: ep.auth_dependency,
    timeoutMs,
    chain: [...chain, requestId],
    allow401Retry: true,
    outputOptions,
  });
  if (!refresh.ok) {
    return refresh;
  }
  return performHttpOnce({
    workspaceRoot,
    def,
    envLocal,
    ep,
    timeoutMs,
    outputOptions,
  });
}

async function performHttpOnce(input: {
  workspaceRoot: string;
  def: ApiDefinitionYaml;
  envLocal: Record<string, string>;
  ep: EndpointDefinition;
  timeoutMs: number;
  outputOptions: ExecuteOutputOptions;
}): Promise<ExecuteResult> {
  const { workspaceRoot, def, envLocal, ep, timeoutMs, outputOptions } =
    input;
  const session = getSession(workspaceRoot);
  const ctx = buildInterpolationContext(
    def.variables,
    envLocal,
    session.variables,
  );

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
    return urlResult;
  }
  const { url } = urlResult;

  const { headers, body } = buildEndpointHeadersAndBody(ep, ctx);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let res: Response;
  let bodyText: string;
  try {
    if (ep.digest_auth) {
      const dig = await fetchWithDigestAuth({
        ep,
        ctx,
        url,
        headers,
        body,
        signal: controller.signal,
      });
      if (!dig.ok) {
        clearTimeout(timer);
        return dig;
      }
      res = dig.response;
    } else {
      res = await fetchPlain({
        url,
        method: ep.method,
        headers,
        body,
        signal: controller.signal,
      });
    }
    // O timer cobre também a leitura do corpo (respostas lentas / streaming).
    bodyText = await readBodyTextCapped(res);
  } catch (e) {
    clearTimeout(timer);
    const msg = controller.signal.aborted
      ? `request timed out after ${timeoutMs}ms`
      : e instanceof Error
        ? e.message
        : String(e);
    return { ok: false, message: `Fetch failed: ${msg}` };
  }
  clearTimeout(timer);
  const durationMs = Date.now() - started;

  return completeSuccessfulExecution({
    workspaceRoot,
    url,
    durationMs,
    ep,
    res,
    bodyText,
    outputOptions,
  });
}

/**
 * Run a single endpoint (including `auth_dependency` pre-flight and one 401 retry).
 */
export async function runEndpointWithDefinition(input: {
  workspaceRoot: string;
  def: ApiDefinitionYaml;
  envLocal: Record<string, string>;
  requestId: string;
  timeoutMs?: number;
  chain: string[];
  /** When false, do not run auth refresh + retry after 401 (used for the retry pass). */
  allow401Retry: boolean;
  outputOptions: ExecuteOutputOptions;
}): Promise<ExecuteResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
  const {
    workspaceRoot,
    def,
    requestId,
    chain,
    allow401Retry,
    outputOptions,
  } = input;

  if (chain.includes(requestId)) {
    return {
      ok: false,
      message: `auth_dependency cycle involving endpoint "${requestId}"`,
    };
  }

  const ep = findEndpoint(def, requestId);
  if (!ep) {
    return {
      ok: false,
      message: `Unknown request id: ${requestId}`,
    };
  }

  const authErr = await ensureAuthDependencySession({
    workspaceRoot,
    def,
    envLocal: input.envLocal,
    ep,
    requestId,
    chain,
    timeoutMs,
    outputOptions,
  });
  if (authErr && !authErr.ok) {
    return authErr;
  }

  let result = await performHttpOnce({
    workspaceRoot,
    def,
    envLocal: input.envLocal,
    ep,
    timeoutMs,
    outputOptions,
  });

  if (allow401Retry) {
    result = await refreshAuthAndRetryRequest({
      workspaceRoot,
      def,
      envLocal: input.envLocal,
      ep,
      requestId,
      chain,
      timeoutMs,
      firstResult: result,
      outputOptions,
    });
  }

  return result;
}

export async function executeEndpointById(input: {
  workspaceRoot: string;
  definitionRelativePath: string;
  requestId: string;
  timeoutMs?: number;
  outputOptions?: ExecuteOutputOptions;
}): Promise<ExecuteResult> {
  const { workspaceRoot, requestId } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
  const filePath = safeResolveUnderWorkspace(
    workspaceRoot,
    input.definitionRelativePath,
  );
  let def: ApiDefinitionYaml;
  try {
    def = readApiDefinitionFile(filePath);
  } catch (e) {
    return {
      ok: false,
      message: `Failed to read definition: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const envLocal = loadEnvMcpLocalParsed(workspaceRoot);

  return runEndpointWithDefinition({
    workspaceRoot,
    def,
    envLocal,
    requestId,
    timeoutMs,
    chain: [],
    allow401Retry: true,
    outputOptions: input.outputOptions ?? {},
  });
}
