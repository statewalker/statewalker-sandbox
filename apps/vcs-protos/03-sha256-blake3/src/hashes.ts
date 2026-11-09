/** X1c — portable incremental SHA-256 and BLAKE3 (plain, keyed, derive-key). STUB (red phase). */

export interface Hasher {
  update(bytes: Uint8Array): Hasher;
  digest(): Uint8Array;
  clone(): Hasher;
}

export interface Blake3Options {
  /** 32-byte key: keyed_hash mode (MAC). */
  key?: Uint8Array;
  /** Encoded context bytes: derive_key mode. */
  context?: Uint8Array;
  /** Output length in bytes (XOF); default 32. */
  dkLen?: number;
}

export function createSha256(): Hasher {
  throw new Error("not implemented");
}

export function createBlake3(_opts?: Blake3Options): Hasher {
  throw new Error("not implemented");
}

/** Git LFS pointer for a stream, computed in one pass (SHA-256 + size). */
export async function lfsPointer(
  _content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<string> {
  throw new Error("not implemented");
}

export function toHex(_bytes: Uint8Array): string {
  throw new Error("not implemented");
}
