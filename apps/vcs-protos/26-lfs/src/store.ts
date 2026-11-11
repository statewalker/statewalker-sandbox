/** X10a — the LFS object store on a FilesApi (red stub). */
import type { FilesApi } from "@statewalker/webrun-files";
import type { Repository } from "../../17-repository/src/object-store.js";
import type { Pointer } from "./pointer.js";

export interface LfsStore {
  has(oid: string): Promise<boolean>;
  size(oid: string): Promise<number | undefined>;
  read(oid: string, opts?: { start?: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  /** streamed, verified (SHA-256 and size when expected), then visible */
  put(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, expect?: Pointer): Promise<Pointer>;
  /** bytes held for an interrupted download */
  incomplete: {
    size(oid: string): Promise<number>;
    append(oid: string, source: AsyncIterable<Uint8Array>): Promise<number>;
    /** verifies what is held and makes it visible */
    complete(expect: Pointer): Promise<void>;
    remove(oid: string): Promise<void>;
  };
}
export function lfsStore(_files: FilesApi, _root: string): LfsStore {
  throw new Error("not implemented");
}
export function repoLfsStore(_repo: Repository): LfsStore {
  throw new Error("not implemented");
}
/** git lfs clean: the content stored, its pointer returned (an empty input is its own pointer) */
export async function clean(
  _store: LfsStore,
  _source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<{ pointer: Uint8Array } & Pointer> {
  throw new Error("not implemented");
}
/** git lfs smudge: a pointer's content; anything else unchanged */
export function smudge(_store: LfsStore, _blob: Uint8Array): AsyncIterable<Uint8Array> {
  throw new Error("not implemented");
}
