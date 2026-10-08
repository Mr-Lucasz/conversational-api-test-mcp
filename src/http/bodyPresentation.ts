import { truncateBody } from "./redact.js";
import { JSONPath } from "jsonpath-plus";

/** Same cap as historical bodyPreview; parse always uses full `bodyText` first. */
export const MAX_BODY_OUT = 50_000;

export type BodyPresentation = {
  bodyPreview: string;
  bodyPreviewTruncated: boolean;
  /** Parsed JSON when valid; large payloads use a minimal wrapper with `topLevelKeys`. */
  bodyJson?: unknown;
};

export type BodyPresentationOptions = {
  /** Cap de caracteres no `bodyPreview` (e, quando houver JSONPath, no preview do resultado). */
  maxBodyChars?: number;
  /**
   * Cap para incluir `bodyJson` (objeto completo vs wrapper minimal).
   * Defaults = `MAX_BODY_OUT` (comportamento legado).
   */
  inlineJsonMaxChars?: number;
  /**
   * Quando false, evita parse JSON (otimiza CPU) e só retorna preview textual.
   * `jsonPathSelect` força parse/seleção.
   */
  includeBodyJson?: boolean;
  /** XPath-ish (jsonpath-plus) para projetar uma subárvore e reduzir tokens na saída. */
  jsonPathSelect?: string;
};

export function projectJson(json: unknown, jsonPathSelect: string): unknown {
  return JSONPath({
    path: jsonPathSelect,
    // jsonpath-plus espera objeto; para primitivos, JSON.parse falha antes e cai no catch.
    json: json as object,
    wrap: false,
  });
}

/**
 * Build `bodyPreview` (truncated for display) and optional `bodyJson` (real object when safe).
 * Never truncates `bodyText` before `JSON.parse` — avoids invalid JSON from mid-string cuts.
 */
export function buildBodyPresentation(
  bodyText: string,
  opts?: BodyPresentationOptions,
): BodyPresentation {
  const maxBodyChars = opts?.maxBodyChars ?? MAX_BODY_OUT;
  const inlineJsonMaxChars = opts?.inlineJsonMaxChars ?? MAX_BODY_OUT;
  const includeBodyJson = opts?.includeBodyJson ?? true;
  const jsonPathSelect = opts?.jsonPathSelect;

  const bodyPreviewTruncated = bodyText.length > maxBodyChars;
  const bodyPreviewRaw = truncateBody(bodyText, maxBodyChars);

  const needJsonParse =
    Boolean(jsonPathSelect) ||
    // Se includeBodyJson=false, mas jsonPathSelect=false, não precisa parse.
    (includeBodyJson && bodyText.length > 0);

  if (!needJsonParse) {
    return { bodyPreview: bodyPreviewRaw, bodyPreviewTruncated };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { bodyPreview: bodyPreviewRaw, bodyPreviewTruncated };
  }

  if (jsonPathSelect) {
    // Sem match o JSONPath devolve undefined; null mantém a saída serializável.
    const projected = projectJson(parsed, jsonPathSelect) ?? null;
    const projectedText = JSON.stringify(projected);
    const projectedTruncated = projectedText.length > maxBodyChars;
    const projectedPreview = truncateBody(projectedText, maxBodyChars);

    if (!includeBodyJson) {
      return {
        bodyPreview: projectedPreview,
        bodyPreviewTruncated: projectedTruncated,
      };
    }

    if (projectedText.length <= inlineJsonMaxChars) {
      return {
        bodyPreview: projectedPreview,
        bodyPreviewTruncated: projectedTruncated,
        bodyJson: projected,
      };
    }

    const topLevelKeys = Array.isArray(projected)
      ? [`[array length ${projected.length}]`]
      : Object.keys(projected as Record<string, unknown>);

    return {
      bodyPreview: projectedPreview,
      bodyPreviewTruncated: projectedTruncated,
      bodyJson: {
        _note:
          "JSON response projection exceeds inline object limit; use bodyPreview (truncated) or session lastResponse for full text.",
        _payloadCharCount: projectedText.length,
        topLevelKeys,
      },
    };
  }

  // Sem JSONPath: preserva o comportamento legado (inlineJsonMaxChars controla o limite do bodyJson).
  if (!includeBodyJson) {
    return { bodyPreview: bodyPreviewRaw, bodyPreviewTruncated };
  }

  if (bodyText.length <= inlineJsonMaxChars) {
    return { bodyPreview: bodyPreviewRaw, bodyPreviewTruncated, bodyJson: parsed };
  }

  const topLevelKeys = Array.isArray(parsed)
    ? [`[array length ${parsed.length}]`]
    : Object.keys(parsed as Record<string, unknown>);

  return {
    bodyPreview: bodyPreviewRaw,
    bodyPreviewTruncated,
    bodyJson: {
      _note:
        "JSON response exceeds inline object limit; use bodyPreview (truncated) or session lastResponse for full text.",
      _payloadCharCount: bodyText.length,
      topLevelKeys,
    },
  };
}
