/** One level deep: arrays by element identity, plain objects by own-key identity. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => Object.is(value, b[i]));
  }
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const keys = Object.keys(ar);
  if (keys.length !== Object.keys(br).length) return false;
  return keys.every((k) => Object.hasOwn(br, k) && Object.is(ar[k], br[k]));
}

/** Arrays of records compared element-wise with `shallowEqual`. */
export function sameRecords<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => shallowEqual(x, b[i]));
}
