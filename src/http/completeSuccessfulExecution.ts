import { assertOnResponse } from "../assertion/assertResponse.js";
import type { EndpointDefinition } from "../canonical/schema.js";
import { captureFromJsonBody } from "./captureFromResponse.js";
import {
  buildBodyPresentation,
  MAX_BODY_OUT,
} from "./bodyPresentation.js";
import {
  maskRecord,
  redactHeaders,
  redactJsonText,
  redactUrl,
} from "./redact.js";
import { setLastResponse } from "../session/SessionStore.js";
import type { ExecuteResult } from "./executeTypes.js";

/** After a successful fetch + body read: session last response, capture, optional assert, presentation. */
export async function completeSuccessfulExecution(input: {
  workspaceRoot: string;
  url: string;
  durationMs: number;
  ep: EndpointDefinition;
  res: Response;
  bodyText: string;
  outputOptions?: {
    responseDetail?: "minimal" | "summary" | "full";
    jsonPathSelect?: string;
    maxBodyChars?: number;
  };
}): Promise<ExecuteResult> {
  const { workspaceRoot, url, durationMs, ep, res, bodyText, outputOptions } =
    input;

  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    resHeaders[k] = v;
  });

  setLastResponse(workspaceRoot, {
    status: res.status,
    headers: resHeaders,
    bodyText,
  });

  const capture = captureFromJsonBody(workspaceRoot, bodyText, ep.capture);

  if (ep.assert) {
    const ar = assertOnResponse(
      { status: res.status, headers: resHeaders, bodyText },
      ep.assert,
    );
    if (!ar.ok) {
      return {
        ok: false,
        message: ar.message,
        status: res.status,
      };
    }
  }

  const responseDetail = outputOptions?.responseDetail ?? "summary";
  const jsonPathSelect = outputOptions?.jsonPathSelect;
  const maxBodyChars = outputOptions?.maxBodyChars;

  // `minimal` vira `summary` se o usuário pedir JSONPath projection (já que precisamos mostrar algo).
  const effectiveResponseDetail =
    responseDetail === "minimal" && jsonPathSelect ? "summary" : responseDetail;

  const includeBodyPreview = effectiveResponseDetail !== "minimal";

  const effectiveMaxBodyChars =
    maxBodyChars ??
    (effectiveResponseDetail === "summary" ? 8_000 : MAX_BODY_OUT);

  // A sessão guarda o corpo bruto (capture/assert); o que volta para o cliente é redigido.
  const pres = includeBodyPreview
    ? buildBodyPresentation(redactJsonText(bodyText), {
        maxBodyChars: effectiveMaxBodyChars,
        // Amarra o limite do bodyJson ao mesmo cap do preview: evita devolver o preview
        // truncado E o objeto completo (até 50k chars) para o mesmo payload.
        inlineJsonMaxChars: effectiveMaxBodyChars,
        includeBodyJson: true,
        jsonPathSelect,
      })
    : null;

  return {
    ok: true,
    url: redactUrl(url),
    status: res.status,
    durationMs,
    // Em `minimal`, headers completos anulariam a economia do modo: omite.
    ...(effectiveResponseDetail === "minimal"
      ? {}
      : { responseHeaders: redactHeaders(resHeaders) }),
    // Omitido quando vazio (endpoint sem `capture`) — não há por que pagar `{}`/`[]` sempre.
    ...(Object.keys(capture.applied).length > 0
      ? { captureApplied: maskRecord(capture.applied) }
      : {}),
    ...(capture.errors.length > 0 ? { captureErrors: capture.errors } : {}),
    // (sem `assertOk`: se chegamos aqui, o assert — quando houver — já passou;
    // um campo sempre `true` não carrega informação nenhuma.)
    ...(includeBodyPreview && pres
      ? {
          bodyPreview: pres.bodyPreview,
          bodyPreviewTruncated: pres.bodyPreviewTruncated,
          ...(pres.bodyJson === undefined ? {} : { bodyJson: pres.bodyJson }),
        }
      : {}),
  };
}
