/** X9 — Fossil-like indexes (stubs) */
import type { Db } from "@statewalker/db-api";
import type { ObjectStore, Repository } from "../../17-repository/src/object-store.js";

export interface FossilIndex {
  indexCommits(tx: Db, tips: string[]): Promise<void>;
  pathHistory(path: string): Promise<string[]>;
  searchMessages(text: string): Promise<string[]>;
}
const todo = (): never => {
  throw new Error("not implemented");
};
export async function fossilIndex(_db: Db, _objects: ObjectStore): Promise<FossilIndex> {
  return todo();
}
export async function indexedSqlRepository(
  _db: Db,
  _opts: { failAfter?: number } = {},
): Promise<{ repo: Repository; index: FossilIndex }> {
  return todo();
}
export async function walkPathHistory(_repo: Repository, _path: string): Promise<string[]> {
  return todo();
}
export async function walkSearch(_repo: Repository, _text: string): Promise<string[]> {
  return todo();
}
