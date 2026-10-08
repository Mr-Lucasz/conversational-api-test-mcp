import { JSONPath } from "jsonpath-plus";
import type {
  ApiDefinitionYaml,
  EndpointDefinition,
} from "../canonical/schema.js";
import { buildEndpointHeadersAndBody } from "../http/buildEndpointRequest.js";
import { fetchPlain, readBodyTextCapped } from "../http/fetchPlain.js";
import { redactJsonText, truncateBody } from "../http/redact.js";
import { resolveRequestUrl } from "../http/resolveRequestUrl.js";
import { runEndpointWithDefinition } from "../http/runEndpoint.js";
import {
  buildInterpolationContext,
  interpolateString,
  interpolateUnknown,
} from "../http/VariableInterpolator.js";
import { deleteSessionVariables, getSession } from "../session/SessionStore.js";
import {
  type RequestVariant,
  type StatusExpectation,
  type VanderCheck,
} from "./plan.js";

const DEFAULT_TIMEOUT = 30_000;
const SNIPPET_CHARS = 300;
const PROBE_CONCURRENCY = 4;
/** Prefix of the `note` of a probe skipped for being state-changing. */
export const DESTRUCTIVE_SKIP = "state-changing";

type RequestCheck = Extract<VanderCheck, { kind: "request" }>;
const LEAK_PATTERN =
  /\bat [\w$.<>]+ \(.+:\d+:\d+\)|Traceback \(most recent call last\)|\bException in thread\b|SQLSTATE|ORA-\d{5}|java\.lang\.\w+Exception/;

type Probe = {
  status: number;
  durationMs: number;
  contentType: string;
  bodyText: string;
};

export type VanderResult = {
  id: string;
  title: string;
  result: "pass" | "fail" | "skipped";
  expected?: string;
  actual?: string;
  note?: string;
};

export type VanderRunInput = {
  workspaceRoot: string;
  def: ApiDefinitionYaml;
  envLocal: Record<string, string>;
  ep: EndpointDefinition;
  checks: VanderCheck[];
  includeDestructive: boolean;
  maxDurationMs: number;
  timeoutMs?: number;
};

function describeExpectation(expect: StatusExpectation): string {
  return Array.isArray(expect) ? `status in [${expect.join(", ")}]` : `status ${expect}`;
}

function statusMatches(status: number, expect: StatusExpectation): boolean {
  if (Array.isArray(expect)) {
    return expect.includes(status);
  }
  if (expect === "2xx") {
    return status >= 200 && status < 300;
  }
  if (expect === "4xx") {
    return status >= 400 && status < 500;
  }
  return status < 500;
}

function snippet(bodyText: string): string {
  return truncateBody(redactJsonText(bodyText), SNIPPET_CHARS);
}

/** Send one probe. Never captures and never touches the session's last response. */
async function sendVariant(
  input: VanderRunInput,
  variant: RequestVariant,
): Promise<Probe | { error: string }> {
  const { workspaceRoot, def, envLocal, ep } = input;
  const ctx = buildInterpolationContext(
    def.variables,
    envLocal,
    getSession(workspaceRoot).variables,
  );
  const urlResult = resolveRequestUrl(
    interpolateString(def.base_url ?? "{{base_url}}", ctx),
    interpolateString(ep.path, ctx),
    ep.params
      ? (interpolateUnknown(ep.params, ctx) as Record<string, string>)
      : undefined,
  );
  if (!urlResult.ok) {
    return { error: urlResult.message };
  }

  const built = buildEndpointHeadersAndBody(ep, ctx);
  let headers = built.headers;
  let body = built.body;

  if (variant.auth) {
    headers = Object.fromEntries(
      Object.entries(headers).filter(
        ([k]) => k.toLowerCase() !== "authorization",
      ),
    );
    if (variant.auth === "invalid") {
      headers.Authorization = "Bearer vander-invalid-token";
    }
  }
  if (variant.dropBodyKey !== undefined) {
    const full = interpolateUnknown(ep.body, ctx) as Record<string, unknown>;
    const rest = Object.fromEntries(
      Object.entries(full).filter(([k]) => k !== variant.dropBodyKey),
    );
    body = JSON.stringify(rest);
  }
  if (variant.rawBody !== undefined) {
    body = variant.rawBody;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchPlain({
      url: urlResult.url,
      method: variant.method ?? ep.method,
      headers,
      body,
      signal: controller.signal,
    });
    const bodyText = await readBodyTextCapped(res);
    return {
      status: res.status,
      durationMs: Date.now() - started,
      contentType: res.headers.get("content-type") ?? "",
      bodyText,
    };
  } catch (e) {
    return {
      error: controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fresh credentials before probing, so a stale token is not reported as an API defect. */
async function refreshAuth(input: VanderRunInput): Promise<string | null> {
  const { workspaceRoot, def, envLocal, ep } = input;
  if (!ep.auth_dependency) {
    return null;
  }
  const authEp = def.endpoints.find((e) => e.id === ep.auth_dependency);
  if (!authEp) {
    return `auth_dependency: unknown endpoint id "${ep.auth_dependency}"`;
  }
  deleteSessionVariables(workspaceRoot, Object.keys(authEp.capture ?? {}));
  const r = await runEndpointWithDefinition({
    workspaceRoot,
    def,
    envLocal,
    requestId: ep.auth_dependency,
    timeoutMs: input.timeoutMs,
    chain: [ep.id],
    allow401Retry: false,
    outputOptions: { responseDetail: "minimal" },
  });
  return r.ok ? null : `auth_dependency failed: ${r.message}`;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function evaluateDerived(
  check: Extract<VanderCheck, { kind: "derived" }>,
  input: VanderRunInput,
  baseline: Probe | undefined,
  probes: Array<{ id: string; probe: Probe }>,
): VanderResult {
  const base = { id: check.id, title: check.title };
  const needsBaseline = (): VanderResult => ({
    ...base,
    result: "skipped",
    note: "needs the baseline request (D-baseline)",
  });

  switch (check.rule) {
    case "content_type": {
      if (!baseline) {
        return needsBaseline();
      }
      const saysJson = /json/i.test(baseline.contentType);
      const structured =
        /^\s*[{[]/.test(baseline.bodyText) && isJson(baseline.bodyText);
      const ok =
        baseline.bodyText === "" ||
        (saysJson ? isJson(baseline.bodyText) : !structured);
      return {
        ...base,
        result: ok ? "pass" : "fail",
        expected: "Content-Type consistent with the body",
        actual: `content-type "${baseline.contentType || "(none)"}", body ${isJson(baseline.bodyText) ? "is" : "is not"} JSON`,
      };
    }
    case "captures": {
      if (!baseline) {
        return needsBaseline();
      }
      if (!isJson(baseline.bodyText)) {
        return { ...base, result: "fail", actual: "response body is not JSON" };
      }
      const data = JSON.parse(baseline.bodyText) as object;
      const missing = Object.entries(input.ep.capture ?? {})
        .filter(([, path]) => {
          const hit = JSONPath({ path, json: data, wrap: false });
          return (
            hit === undefined ||
            hit === null ||
            (Array.isArray(hit) && hit.length === 0)
          );
        })
        .map(([name]) => name);
      return {
        ...base,
        result: missing.length ? "fail" : "pass",
        ...(missing.length ? { actual: `no match for: ${missing.join(", ")}` } : {}),
      };
    }
    case "duration": {
      if (!baseline) {
        return needsBaseline();
      }
      return {
        ...base,
        result: baseline.durationMs <= input.maxDurationMs ? "pass" : "fail",
        expected: `<= ${input.maxDurationMs}ms`,
        actual: `${baseline.durationMs}ms`,
      };
    }
    case "no_server_errors": {
      if (probes.length === 0) {
        return { ...base, result: "skipped", note: "no probe was sent" };
      }
      const bad = probes.filter((p) => p.probe.status >= 500);
      return {
        ...base,
        result: bad.length ? "fail" : "pass",
        ...(bad.length
          ? { actual: bad.map((p) => `${p.id} -> ${p.probe.status}`).join("; ") }
          : {}),
      };
    }
    case "no_stack_trace": {
      if (probes.length === 0) {
        return { ...base, result: "skipped", note: "no probe was sent" };
      }
      const bad = probes.filter(
        (p) => p.probe.status >= 400 && LEAK_PATTERN.test(p.probe.bodyText),
      );
      return {
        ...base,
        result: bad.length ? "fail" : "pass",
        ...(bad.length ? { actual: `leak in: ${bad.map((p) => p.id).join(", ")}` } : {}),
      };
    }
  }
}

/** Run every automatic check of the plan; manual checks are left to the caller. */
export async function runVanderChecks(
  input: VanderRunInput,
): Promise<VanderResult[]> {
  const { ep, checks } = input;
  const requestChecks = checks.filter(
    (c): c is RequestCheck => c.kind === "request",
  );

  const blocker = ep.digest_auth
    ? "digest_auth endpoints are plan-only (probes are not sent)"
    : await refreshAuth(input);

  const results = new Map<string, VanderResult>();
  const probeById = new Map<string, Probe>();

  const runProbe = async (check: RequestCheck): Promise<void> => {
    const base = { id: check.id, title: check.title };
    const expected = describeExpectation(check.expect);
    const probe = await sendVariant(input, check.variant);
    if ("error" in probe) {
      results.set(check.id, { ...base, result: "fail", expected, actual: probe.error });
      return;
    }
    probeById.set(check.id, probe);
    const ok = statusMatches(probe.status, check.expect);
    results.set(check.id, {
      ...base,
      result: ok ? "pass" : "fail",
      expected,
      actual: `status ${probe.status} in ${probe.durationMs}ms`,
      ...(ok || !probe.bodyText ? {} : { note: snippet(probe.bodyText) }),
    });
  };

  // Read-only probes are independent of each other: send them a few at a time.
  // State-changing ones keep the plan order, and so does the baseline — measured
  // alone, after the batch, so R-duration is not inflated by the other probes.
  const parallel: RequestCheck[] = [];
  const serial: RequestCheck[] = [];
  for (const check of requestChecks) {
    const skip = blocker
      ? blocker
      : check.destructive && !input.includeDestructive
        ? `${DESTRUCTIVE_SKIP} (${check.variant.method ?? ep.method})`
        : null;
    if (skip) {
      results.set(check.id, {
        id: check.id,
        title: check.title,
        result: "skipped",
        note: skip,
      });
    } else if (check.destructive || check.id === "D-baseline") {
      serial.push(check);
    } else {
      parallel.push(check);
    }
  }
  await Promise.all(
    Array.from({ length: PROBE_CONCURRENCY }, async () => {
      for (let c = parallel.shift(); c; c = parallel.shift()) {
        await runProbe(c);
      }
    }),
  );
  for (const check of serial) {
    await runProbe(check);
  }

  const probes = requestChecks.flatMap((c) => {
    const probe = probeById.get(c.id);
    return probe ? [{ id: c.id, probe }] : [];
  });
  const baseline = probeById.get("D-baseline");

  for (const check of checks) {
    if (check.kind === "derived") {
      results.set(check.id, evaluateDerived(check, input, baseline, probes));
    }
  }

  return checks
    .map((c) => results.get(c.id))
    .filter((r): r is VanderResult => r !== undefined);
}
