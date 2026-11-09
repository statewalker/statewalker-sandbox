/**
 * X1c — portable incremental SHA-256 and BLAKE3 (plain, keyed, derive-key) on @noble/hashes.
 * No `node:` imports: the same module runs in browsers, workers, Node and Durable Objects.
 */
import { blake3 } from "@noble/hashes/blake3.js";
import { sha256 } from "@noble/hashes/sha2.js";

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

interface NobleHash {
  update(b: Uint8Array): unknown;
  digest(): Uint8Array;
  clone(): NobleHash;
}

function wrap(h: NobleHash): Hasher {
  const self: Hasher = {
    update(b) {
      h.update(b);
      return self;
    },
    digest: () => h.digest(),
    clone: () => wrap(h.clone()),
  };
  return self;
}

export function createSha256(): Hasher {
  return wrap(sha256.create() as unknown as NobleHash);
}

export function createBlake3(opts?: Blake3Options): Hasher {
  return wrap(blake3.create(opts ?? {}) as unknown as NobleHash);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += HEX[b];
  return s;
}

/**
 * Git LFS pointer for a stream, computed in one pass (SHA-256 + size).
 * Per the LFS pointer spec an empty file is its own pointer: `git lfs pointer` prints nothing
 * for it, and clean filters leave empty files unconverted. Found by R4's oracle, not assumed.
 */
export async function lfsPointer(
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<string> {
  const h = createSha256();
  let size = 0;
  for await (const chunk of content) {
    h.update(chunk);
    size += chunk.length;
  }
  if (size === 0) return "";
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${toHex(h.digest())}\nsize ${size}\n`;
}
