export type ExecuteResult =
  | {
      ok: true;
      url: string;
      status: number;
      durationMs: number;
      /** Omitted in `minimal`; a short allowlist in `summary`; every header in `full`. */
      responseHeaders?: Record<string, string>;
      /** Non-JSON bodies, or the truncated start of a JSON body that exceeded the cap. */
      bodyPreview?: string;
      /** Present (true) only when the body exceeded the cap. */
      bodyPreviewTruncated?: boolean;
      /** Parsed JSON when it fits the cap; a wrapper with `topLevelKeys` when it does not. */
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
