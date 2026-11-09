/**
 * X1a — single-pass git object hashing over a byte stream with a declared size.
 * STUB (red phase): every export throws until implemented.
 */

export type GitObjectType = "blob" | "tree" | "commit" | "tag";
export type Sha1Impl = "vcs" | "noble" | "node";

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

export function createSha1(_impl: Sha1Impl): Hasher {
  throw new Error("not implemented");
}

export async function hashGitObject(
  _type: GitObjectType,
  _size: number,
  _content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  _impl: Sha1Impl,
): Promise<string> {
  throw new Error("not implemented");
}
