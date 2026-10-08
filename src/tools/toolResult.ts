import { encode } from "@toon-format/toon";

/**
 * TOON (Token-Oriented Object Notation) em vez de JSON: mesmo dado, menos tokens
 * — ganho maior em arrays uniformes (ex.: bodyJson de listagens), mas também
 * economiza no envelope escalar (sem aspas em chaves, sem vírgulas).
 * https://github.com/toon-format/spec
 *
 * O encoder lança exceção em casos que JSON.stringify sempre tolerou (ex.:
 * string com surrogate UTF-16 solto, possível se algum truncamento cortar no
 * meio de um par). truncateBody (src/http/redact.ts) já evita isso, mas este é
 * o único funil por onde toda resposta de tool passa — nunca deve derrubar uma
 * chamada por um caso imprevisto, então cai pra JSON compacto se o encode falhar.
 */
export function textResult(
  obj: unknown,
  isError?: boolean,
): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  let text: string;
  try {
    text = encode(obj);
  } catch {
    text = JSON.stringify(obj);
  }
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Tira chaves `null`/`undefined` do nível de topo de um resultado de tool: o encoder
 * escreve `chave: null` para as duas, e uma ausência não precisa custar uma linha.
 * Raso de propósito — `null` dentro do corpo de uma resposta de API é dado, não ausência.
 */
export function omitNullish<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined),
  ) as Partial<T>;
}

export async function safeTool<T>(
  fn: () => Promise<T>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    const data = await fn();
    return textResult(data, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textResult({ error: msg }, true);
  }
}
