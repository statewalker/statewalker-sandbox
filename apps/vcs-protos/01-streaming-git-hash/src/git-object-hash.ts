/**
 * X1a — single-pass git object hashing over a byte stream with a declared size.
 *
 * git object id = sha1("<type> <size>\0" + content). Because the header needs the
 * size, the caller must declare it up front (from FilesApi stats, a pack entry
 * header, or Content-Length). The content is then fed to the hasher exactly once,
 * chunk by chunk, and never retained — that is what removes vcs-core's current
 * "store, read back, hash" double pass.
 */
import { sha1 as nobleSha1 } from "@noble/hashes/legacy.js";
import { Sha1 } from "./vendor/sha-1.js";

export type GitObjectType = "blob" | "tree" | "commit" | "tag";
/** Portable implementations; the Node accelerator lives in node-sha1.ts. */
export type Sha1Impl = "vcs" | "noble";

/** Minimal incremental hasher — the shape PlatformServices.hash.create() is expected to return. */
export interface Hasher {
  update(bytes: Uint8Array): Hasher;
  digest(): Uint8Array;
}

export class SizeMismatchError extends Error {
  constructor(
    readonly declared: number,
    readonly actual: number,
  ) {
    super(`declared size ${declared} but stream produced ${actual === -1 ? "more" : actual} bytes`);
    this.name = "SizeMismatchError";
  }
}

export function createSha1(impl: Sha1Impl): Hasher {
  switch (impl) {
    case "vcs": {
      const h = new Sha1();
      const self: Hasher = {
        update(b) {
          h.update(b);
          return self;
        },
        digest: () => h.finalize(),
      };
      return self;
    }
    case "noble": {
      const h = nobleSha1.create();
      const self: Hasher = {
        update(b) {
          h.update(b);
          return self;
        },
        digest: () => h.digest(),
      };
      return self;
    }
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += HEX[b];
  return s;
}

export async function hashGitObject(
  type: GitObjectType,
  size: number,
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  createHasher: () => Hasher = () => createSha1("noble"),
): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`object size must be a non-negative safe integer, got ${size}`);
  }
  const hasher = createHasher();
  hasher.update(new TextEncoder().encode(`${type} ${size}\0`));
  let seen = 0;
  for await (const chunk of content) {
    seen += chunk.length;
    // Fail as soon as the stream overruns — do not hash bytes we already know are wrong.
    if (seen > size) throw new SizeMismatchError(size, -1);
    hasher.update(chunk);
  }
  if (seen !== size) throw new SizeMismatchError(size, seen);
  return toHex(hasher.digest());
}
