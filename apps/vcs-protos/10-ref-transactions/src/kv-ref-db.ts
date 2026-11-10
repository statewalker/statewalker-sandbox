/** X5 — KvStore backend: all refs under one root key, a batch is one root compare-and-set. Stub. */
import type { KvStore } from "@statewalker/webrun-storage";
import type { RefDb } from "./ref-db.js";

export function kvRefDb(_kv: KvStore, _root = "refs"): RefDb {
  throw new Error("not implemented");
}
/** Bytes of the root value holding `n` refs (for the DO value-limit check). */
export function snapshotSize(_n: number): number {
  throw new Error("not implemented");
}
