/**
 * Plain-JSON helpers. Everything that crosses the sync boundary is plain JSON: that is what makes
 * operations storable as IndexedDB rows, hashable and (when E2EE is on) encryptable.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const MAX_JSON_DEPTH = 12;

/** True for plain JSON only: no undefined, NaN/Infinity, class instances, or `__proto__` keys. */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (value === null) return true;
      if (Array.isArray(value)) return value.every((v) => isJsonValue(v, depth + 1));
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) return false;
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key === '__proto__' || !isJsonValue(record[key], depth + 1)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  return ka.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]));
}

/** Deterministic serialisation (object keys sorted): used for hashing and authenticated data. */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`).join(',')}}`;
}
