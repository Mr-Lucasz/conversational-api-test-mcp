import type { ParseLoss } from "./LegacyParserStrategy.js";

/**
 * Known conversion gaps (benchmark / shift-left matrix), for reports and docs in code.
 */
export const KNOWN_LOSS_CODES = {
  POSTMAN_PRE_REQUEST_SCRIPTS: "Events / pre-request scripts are not executed.",
  POSTMAN_TESTS: "Post-run test scripts are not converted.",
  OAS_REF: "$ref expansion and rich requestBody schemas are limited in v1 import.",
  OAS_SECURITY_SCHEMES: "Global security schemes are not auto-wired to each request.",
  INSOMNIA_GRPC: "Non-HTTP Insomnia resources are skipped.",
  APIDOG_NATIVE: "Use Apidog export as OpenAPI or Insomnia export.",
} as const;

export type PostmanScriptSignals = {
  hasUuidLike: boolean;
  hasOAuthLike: boolean;
};

/** Heuristic scan of Postman script source (collection + folders + requests). */
export function detectPostmanScriptSignals(scriptText: string): PostmanScriptSignals {
  return {
    hasUuidLike:
      /\b(uuid|randomUUID|randomUuid|guid)\b/i.test(scriptText),
    hasOAuthLike:
      /\boauth|access_token|bearer|client_credentials|refresh_token|grant_type|openid\b/i.test(
        scriptText,
      ),
  };
}

export function mergePostmanScriptSignals(
  a: PostmanScriptSignals,
  b: PostmanScriptSignals,
): PostmanScriptSignals {
  return {
    hasUuidLike: a.hasUuidLike || b.hasUuidLike,
    hasOAuthLike: a.hasOAuthLike || b.hasOAuthLike,
  };
}

/**
 * Build conversion losses for Postman collection/folder/request scripts with actionable hints.
 */
export function buildPostmanScriptLosses(
  signals: PostmanScriptSignals,
  counts: { prerequest: number; test: number },
): ParseLoss[] {
  const losses: ParseLoss[] = [];
  if (counts.prerequest > 0) {
    let msg: string = KNOWN_LOSS_CODES.POSTMAN_PRE_REQUEST_SCRIPTS;
    const hints: string[] = [];
    if (signals.hasUuidLike) {
      hints.push(
        "Use {{$uuid}}, {{$date:YYYY-MM-DD}}, or {{$timestamp}} in canonical YAML instead of script-generated values.",
      );
    }
    if (signals.hasOAuthLike) {
      hints.push(
        "Model token retrieval as an endpoint with capture, set auth_dependency on protected requests, and put secrets in .env.mcp.local.",
      );
    }
    if (hints.length) {
      msg = `${msg} ${hints.join(" ")}`;
    }
    losses.push({
      code: "POSTMAN_PRE_REQUEST_SCRIPTS",
      message: msg,
    });
  }
  if (counts.test > 0) {
    losses.push({
      code: "POSTMAN_TESTS",
      message: KNOWN_LOSS_CODES.POSTMAN_TESTS,
    });
  }
  return losses;
}
