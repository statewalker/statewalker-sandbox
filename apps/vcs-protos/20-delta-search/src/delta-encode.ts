/** git's binary delta encoder (X6e) — red stub. */
export interface DeltaIndex {
  source: Uint8Array;
}
export function deltaIndex(_source: Uint8Array): DeltaIndex {
  throw new Error("not implemented");
}
export function encodeDelta(
  _index: DeltaIndex,
  _target: Uint8Array,
  _maxSize?: number,
): Uint8Array | undefined {
  throw new Error("not implemented");
}
