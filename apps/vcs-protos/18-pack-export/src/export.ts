/** X6c — red stub. */
import type { ObjectType, Repository } from "../../17-repository/src/object-store.js";

export interface ToSend {
  oid: string;
  type: ObjectType;
}
export async function listObjects(
  _repo: Repository,
  _wants: string[],
  _haves: string[],
): Promise<ToSend[]> {
  throw new Error("not implemented");
}
export function writePack(
  _repo: Repository,
  _objects: ToSend[],
  _opts: { signal?: AbortSignal } = {},
): AsyncGenerator<Uint8Array> {
  throw new Error("not implemented");
}
export async function* exportPack(
  repo: Repository,
  wants: string[],
  haves: string[],
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<Uint8Array> {
  yield* writePack(repo, await listObjects(repo, wants, haves), opts);
}
