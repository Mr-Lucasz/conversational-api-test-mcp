export type ExecuteResult =
  | {
      ok: true;
      url: string;
      status: number;
      durationMs: number;
      /** Omitted when `responseDetail: "minimal"` — full headers would defeat the point of minimal. */
      responseHeaders?: Record<string, string>;
      bodyPreview?: string;
      /** True when raw body length exceeded the preview cap (string truncated for display only). */
      bodyPreviewTruncated?: boolean;
      /** Parsed JSON when valid; omitted for non-JSON. Large JSON uses a minimal wrapper (see bodyPresentation). */
      bodyJson?: unknown;
      /** Omitido quando não há captures aplicadas (economiza `{}` em toda resposta sem `capture`). */
      captureApplied?: Record<string, string>;
      /** Omitido quando não há erros de capture. */
      captureErrors?: string[];
    }
  | {
      ok: false;
      message: string;
      /** HTTP status when a response was received but the endpoint `assert` failed. */
      status?: number;
    };
