/**
 * X4 — raw-bytes git object kernel over a StagingBlobStore.
 */
import type { ByteStream } from "@statewalker/webrun-storage";
import type { StagingBlobStore } from "./staging.js";

export type ObjectType = "blob" | "tree" | "commit" | "tag";

export class ObjectIdMismatchError extends Error {
  override name = "ObjectIdMismatchError";
}
export class CorruptObjectError extends Error {
  override name = "CorruptObjectError";
}

export interface GitObject {
  type: ObjectType;
  size: number;
  content: ByteStream;
}

export interface GitObjects {
  /** One pass over `content`: hash, deflate and stage together. Returns git's id. */
  put(type: ObjectType, size: number, content: ByteStream): Promise<string>;
  /** Store an uncompressed loose object (`"<type> <size>\0" + content`) received with its id. */
  putRaw(id: string, raw: ByteStream): Promise<void>;
  /** Inflated loose object, header included. Empty stream if absent. */
  getRaw(id: string): ByteStream;
  /** Parsed header and content; `verify` re-hashes and throws at the end on mismatch. */
  get(id: string, opts?: { verify?: boolean }): Promise<GitObject | undefined>;
  has(id: string): Promise<boolean>;
  /** Object ids only (40 hex), whatever else lives in the store. */
  list(): AsyncIterable<string>;
}

export function gitObjects(_store: StagingBlobStore): GitObjects {
  throw new Error("not implemented");
}
