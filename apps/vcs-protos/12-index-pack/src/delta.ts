/** git binary delta application, bounds-checked (git patch-delta.c, JGit BinaryDelta). Stub. */
export class DeltaError extends Error {
  override name = "DeltaError";
}
export function applyDelta(_base: Uint8Array, _delta: Uint8Array): Uint8Array {
  throw new Error("not implemented");
}
