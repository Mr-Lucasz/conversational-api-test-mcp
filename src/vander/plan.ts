import type {
  ApiDefinitionYaml,
  EndpointDefinition,
} from "../canonical/schema.js";

/**
 * VANDER — API testing heuristic used by the `vander` persona:
 * Verbs, Authorization, Negative, Data, Errors, Responsiveness.
 */
export const VANDER_AXES = [
  { key: "V", name: "Verbs" },
  { key: "A", name: "Authorization" },
  { key: "N", name: "Negative" },
  { key: "D", name: "Data" },
  { key: "E", name: "Errors" },
  { key: "R", name: "Responsiveness" },
] as const;

export type VanderAxis = (typeof VANDER_AXES)[number]["key"];
export type HttpMethod = EndpointDefinition["method"];

/** How a probe differs from the endpoint as declared. `{}` = send it as-is. */
export type RequestVariant = {
  method?: HttpMethod;
  auth?: "none" | "invalid";
  dropBodyKey?: string;
  rawBody?: string;
};

export type StatusExpectation = number[] | "2xx" | "4xx" | "not5xx";

export type DerivedRule =
  | "content_type"
  | "captures"
  | "no_server_errors"
  | "no_stack_trace"
  | "duration";

export type VanderCheck = {
  id: string;
  axis: VanderAxis;
  title: string;
} & (
  | {
      kind: "request";
      variant: RequestVariant;
      expect: StatusExpectation;
      /** Sends a state-changing method; only runs with `includeDestructive`. */
      destructive: boolean;
    }
  | { kind: "derived"; rule: DerivedRule }
  | { kind: "manual" }
);

const SAFE_METHODS = new Set<HttpMethod>(["GET", "HEAD", "OPTIONS"]);
const ALL_METHODS: HttpMethod[] = [
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];
const REJECTED = [401, 403];
const METHOD_NOT_ALLOWED = [405, 404, 501];
const MAX_DROP_KEY_PROBES = 5;

export function isSafeMethod(method: HttpMethod): boolean {
  return SAFE_METHODS.has(method);
}

function plainObjectBody(
  ep: EndpointDefinition,
): Record<string, unknown> | undefined {
  const b = ep.body;
  return b !== null && typeof b === "object" && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : undefined;
}

function declaresAuth(ep: EndpointDefinition): boolean {
  return Boolean(
    ep.auth ||
      ep.auth_dependency ||
      ep.digest_auth ||
      Object.keys(ep.headers ?? {}).some(
        (h) => h.toLowerCase() === "authorization",
      ),
  );
}

/** Deterministic VANDER checklist for one endpoint, derived only from its definition. */
export function buildVanderPlan(
  def: ApiDefinitionYaml,
  ep: EndpointDefinition,
): VanderCheck[] {
  const unsafe = !isSafeMethod(ep.method);
  const checks: VanderCheck[] = [];
  const manual = (axis: VanderAxis, n: number, title: string) =>
    checks.push({ id: `${axis}-m${n}`, axis, title, kind: "manual" });

  // V — Verbs
  const declared = new Set<HttpMethod>(
    def.endpoints.filter((e) => e.path === ep.path).map((e) => e.method),
  );
  if (declared.has("GET")) {
    declared.add("HEAD");
  }
  for (const method of ALL_METHODS) {
    if (declared.has(method)) {
      continue;
    }
    const isOptions = method === "OPTIONS";
    checks.push({
      id: `V-${method.toLowerCase()}`,
      axis: "V",
      title: isOptions
        ? "OPTIONS does not cause a server error"
        : `${method} (not declared for this path) is rejected`,
      kind: "request",
      variant: { method },
      expect: isOptions ? "not5xx" : METHOD_NOT_ALLOWED,
      destructive: !isSafeMethod(method),
    });
  }

  // A — Authorization
  if (declaresAuth(ep) && !ep.digest_auth) {
    checks.push(
      {
        id: "A-none",
        axis: "A",
        title: "Request without credentials is rejected",
        kind: "request",
        variant: { auth: "none" },
        expect: REJECTED,
        destructive: unsafe,
      },
      {
        id: "A-invalid",
        axis: "A",
        title: "Request with an invalid token is rejected",
        kind: "request",
        variant: { auth: "invalid" },
        expect: REJECTED,
        destructive: unsafe,
      },
    );
    manual("A", 1, "Token of another user / lower scope gets 403, not data");
    manual("A", 2, "Expired token gets 401");
  } else if (ep.digest_auth) {
    manual("A", 1, "Wrong digest password is rejected with 401");
    manual("A", 2, "Request without digest credentials is rejected with 401");
  } else {
    manual("A", 1, "No auth declared: confirm this endpoint is meant to be public");
  }

  // N — Negative
  const body = plainObjectBody(ep);
  if (body) {
    for (const key of Object.keys(body).slice(0, MAX_DROP_KEY_PROBES)) {
      checks.push({
        id: `N-drop-${key}`,
        axis: "N",
        title: `Body without "${key}" is rejected or handled explicitly`,
        kind: "request",
        variant: { dropBodyKey: key },
        expect: "4xx",
        destructive: unsafe,
      });
    }
    manual("N", 1, "Wrong types, nulls, empty strings and boundary values per field");
    manual("N", 2, "Unknown extra field is ignored or rejected, never stored blindly");
  }
  if (ep.form) {
    manual("N", 3, "Form with a missing / empty required field is rejected");
  }
  if (ep.params) {
    manual("N", 4, "Invalid, missing and out-of-range query parameters");
  }
  if (/\{\{[^}]+\}\}|\/\d+(\/|$)/.test(ep.path)) {
    manual("N", 5, "Non-existent id in the path returns 404; malformed id returns 400/404");
  }

  // D — Data
  checks.push({
    id: "D-baseline",
    axis: "D",
    title: "Request as declared succeeds",
    kind: "request",
    variant: {},
    expect: ep.assert?.status !== undefined ? [ep.assert.status] : "2xx",
    destructive: unsafe,
  });
  checks.push({
    id: "D-content-type",
    axis: "D",
    title: "Content-Type matches the body actually returned",
    kind: "derived",
    rule: "content_type",
  });
  if (ep.capture) {
    checks.push({
      id: "D-captures",
      axis: "D",
      title: "Every captured JSONPath exists in the response",
      kind: "derived",
      rule: "captures",
    });
  }
  manual("D", 1, "Response fields match the contract (names, types, required)");
  if (unsafe) {
    manual("D", 2, "Side effect is visible in a follow-up read; repeating the call is idempotent or rejected");
  }

  // E — Errors
  if (body) {
    checks.push({
      id: "E-malformed-json",
      axis: "E",
      title: "Malformed JSON body is rejected with a client error",
      kind: "request",
      variant: { rawBody: '{"vander":' },
      expect: [400, 415, 422],
      destructive: unsafe,
    });
  }
  checks.push(
    {
      id: "E-no-5xx",
      axis: "E",
      title: "No probe made the server answer 5xx",
      kind: "derived",
      rule: "no_server_errors",
    },
    {
      id: "E-no-leak",
      axis: "E",
      title: "Error bodies do not leak stack traces or database errors",
      kind: "derived",
      rule: "no_stack_trace",
    },
  );
  manual("E", 1, "Error body has a stable shape (code + message) and the right status");

  // R — Responsiveness
  checks.push({
    id: "R-duration",
    axis: "R",
    title: "Baseline answers within the duration budget",
    kind: "derived",
    rule: "duration",
  });
  manual("R", 1, "Rate limiting answers 429 (ideally with Retry-After)");
  manual("R", 2, "Behaviour when a dependency is slow: timeout, not a hang");

  return checks;
}
