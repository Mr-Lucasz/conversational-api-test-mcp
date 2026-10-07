/**
 * Corta uma string por contagem de UTF-16 code units, mas nunca no meio de um
 * par surrogate (emoji e outros caracteres fora do BMP usam 2 code units).
 * Cortar no meio produz uma string com surrogate solto — inofensivo pro
 * JSON.stringify, mas o encoder TOON (@toon-format/toon) lança exceção nesse
 * caso, então esse corte precisa ser seguro em qualquer lugar que trunca texto
 * antes de a resposta virar TOON (ver src/tools/toolResult.ts).
 */
export function safeSliceString(value: string, maxChars: number): string {
  // Clampa antes de qualquer coisa: maxChars<=0 deve sempre truncar pra "", nunca
  // cair no comportamento de índice negativo do String#slice (conta do fim da
  // string), que devolveria quase tudo em vez de quase nada.
  let end = Math.max(0, maxChars);
  if (end > 0 && end < value.length) {
    const code = value.charCodeAt(end - 1);
    // 0xD800–0xDBFF: high surrogate — se for o último char incluído, a metade
    // baixa ficaria de fora e sobra um surrogate solto. Recua 1 posição.
    if (code >= 0xd800 && code <= 0xdbff) {
      end -= 1;
    }
  }
  return value.slice(0, end);
}
