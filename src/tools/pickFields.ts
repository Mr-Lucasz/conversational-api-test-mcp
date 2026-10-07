/**
 * Projeta um objeto raso para só as chaves pedidas em `fields`. `undefined`/vazio = sem corte
 * (comportamento atual, retrocompatível). Chaves inexistentes em `obj` são ignoradas.
 */
export function pickFields<T extends Record<string, unknown>>(
  obj: T,
  fields: string[] | undefined,
): Partial<T> {
  if (!fields || fields.length === 0) {
    return obj;
  }
  const out: Partial<T> = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, f)) {
      out[f as keyof T] = obj[f as keyof T];
    }
  }
  return out;
}
