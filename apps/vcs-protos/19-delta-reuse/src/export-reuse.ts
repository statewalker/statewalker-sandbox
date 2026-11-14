/**
 * X6d — pack export reusing what packs hold, as git's pack-objects does (reuse_object/reuse_delta).
 *
 * For each object to send, decided before writing:
 *  - stored whole in a pack: its compressed bytes are copied after a fresh header (no inflate,
 *    no deflate);
 *  - stored as a delta (OFS or REF) whose base is also sent: the delta's compressed bytes are
 *    copied as a REF_DELTA against that base;
 *  - stored as a delta whose base the receiver has (`thin`): copied as a REF_DELTA against it — a
 *    thin pack, completed by the receiver (`index-pack --fix-thin`, X6b's externalBase);
 *  - otherwise (loose, or a delta whose base goes nowhere): inflated and deflated whole (X6c).
 * A copied entry is checked against its idx CRC before any of its bytes are sent (git checks it
 * before reusing): entries up to 1 MiB compressed are buffered, larger ones read twice (a CRC
 * pass, then the copy, checked again as it streams). A copy that fails is marked bad and the object
 * is sent whole from another copy (`get` skips bad copies); with none, the export fails before
 * the entry starts — a corrupt entry is never passed on.
 * Deltas copied from different packs can form a cycle (pack 1 stores A against B, pack 2 B against
 * A): the decisions are checked, and an object on a cycle is sent whole. Chains are cut at git's
 * default depth (50): a delta deeper is sent whole. Each copied delta's base is written before it.
 * A copied delta's type is not checked against the listed type (its result type is the base's,
 * known only by resolving it); whole copies are.
 * Shallow receivers: pass their shallow commits (`shallow`) so `receiverHas` holds only objects
 * they have — a thin base is taken from that set only.
 * Cost: the decision pass reads one entry header per object and keeps a plan per object (O(N)).
 */

import { sha1 } from "@noble/hashes/legacy.js";
import { Deflate } from "pako";
import { PackError, type PackedEntry } from "../../13-pack-reader/src/pack-reader.js";
import type { ObjectType, Repository } from "../../17-repository/src/object-store.js";
import {
  listObjectsWithEdges,
  type ToSend,
  type WalkOptions,
} from "../../18-pack-export/src/export.js";

export interface ReuseStats {
  reusedWhole: number;
  reusedDelta: number;
  thinDelta: number;
  deflated: number;
  /** deltas computed by a `refine` step (X6e's search) */
  computed?: number;
}
export interface ReuseOptions {
  signal?: AbortSignal;
  /** send deltas against objects the receiver has (REF_DELTA; completed with --fix-thin) */
  thin?: boolean;
  stats?: ReuseStats;
}

export const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const REF_DELTA = 7;
/** git pack-objects' default --depth */
export const MAX_DEPTH = 50;
/** copied entries up to this compressed size are buffered for the CRC check; larger are read twice */
const BUFFER_MAX = 2 ** 20;
const unhex = (h: string) => {
  // by character codes: a regex and a parseInt per byte were a measured cost on hot paths
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const a = h.charCodeAt(2 * i);
    const b = h.charCodeAt(2 * i + 1);
    out[i] = ((a <= 57 ? a - 48 : (a | 32) - 87) << 4) | (b <= 57 ? b - 48 : (b | 32) - 87);
  }
  return out;
};

function entryHeader(kind: number, size: number, baseOid?: string): Uint8Array {
  const out: number[] = [];
  let b = (kind << 4) | (size & 15);
  let s = Math.floor(size / 16);
  while (s) {
    out.push(b | 0x80);
    b = s & 127;
    s = Math.floor(s / 128);
  }
  out.push(b);
  if (baseOid) out.push(...unhex(baseOid));
  return Uint8Array.from(out);
}

export type Plan =
  | { mode: "whole"; entry: PackedEntry }
  | { mode: "delta" | "thin"; entry: PackedEntry; base: string }
  /** a delta computed against `base` (sent, or one the receiver has): its bytes when written */
  | { mode: "computed"; base: string; delta: () => Promise<Uint8Array> }
  | { mode: "deflate" };

export interface WriteOptions extends ReuseOptions {
  receiverHas?: (oid: string) => boolean;
  /**
   * Called with the reuse plan (cycle-free) before writing: may replace "whole" and "deflate"
   * plans with "computed" ones (X6e's delta search). Their bases must not form cycles.
   */
  refine?: (plan: Map<string, Plan>) => Promise<void>;
  /** the deepest chain written (git's --depth); deeper deltas are sent whole. Default 50. */
  depth?: number;
}

export async function* writePackReusing(
  repo: Repository,
  objects: ToSend[],
  opts: WriteOptions = {},
): AsyncGenerator<Uint8Array> {
  const signal = opts.signal;
  const stats = opts.stats;
  const sending = new Set(objects.map((o) => o.oid));
  // --- decide (entry headers only: a small read each)
  const plan = new Map<string, Plan>();
  for (const o of objects) {
    signal?.throwIfAborted();
    const e = await repo.objects.packedEntry?.(o.oid);
    let p: Plan = { mode: "deflate" };
    if (e?.type) {
      if (e.type === o.type) p = { mode: "whole", entry: e };
    } else if (e?.baseOid) {
      if (sending.has(e.baseOid)) p = { mode: "delta", entry: e, base: e.baseOid };
      else if (opts.thin && opts.receiverHas?.(e.baseOid))
        p = { mode: "thin", entry: e, base: e.baseOid };
    }
    plan.set(o.oid, p);
  }
  // --- no delta cycles: follow each delta's base chain among the copied deltas
  const state = new Map<string, "visiting" | "done">();
  for (const o of objects) {
    const chain: string[] = [];
    let cur: string | undefined = o.oid;
    while (cur && !state.has(cur)) {
      const p = plan.get(cur);
      if (p?.mode !== "delta") break;
      state.set(cur, "visiting");
      chain.push(cur);
      cur = p.base;
    }
    if (cur && state.get(cur) === "visiting") plan.set(cur, { mode: "deflate" }); // break the cycle here
    for (const c of chain) state.set(c, "done");
  }
  await opts.refine?.(plan);
  // --- depth cap and base-first order (bases among the copied deltas, now acyclic)
  const maxDepth = opts.depth ?? MAX_DEPTH;
  const depth = new Map<string, number>();
  const order: ToSend[] = [];
  const byOid = new Map(objects.map((o) => [o.oid, o]));
  const place = (oid: string): number => {
    const known = depth.get(oid);
    if (known !== undefined) return known;
    const p = plan.get(oid) as Plan;
    let d = 0;
    if (p.mode === "delta") {
      d = place(p.base) + 1; // depth ≤ maxDepth bounds this recursion
      if (d > maxDepth) {
        plan.set(oid, { mode: "deflate" });
        d = 0;
      }
    } else if (p.mode === "computed") {
      d = sending.has(p.base) ? place(p.base) + 1 : 1;
      if (d > maxDepth) {
        plan.set(oid, { mode: "deflate" });
        d = 0;
      }
    } else if (p.mode === "thin") d = 1;
    depth.set(oid, d);
    order.push(byOid.get(oid) as ToSend);
    return d;
  };
  for (const o of objects) place(o.oid);
  // --- write
  const hash = sha1.create();
  const emit = (b: Uint8Array) => {
    hash.update(b);
    return b;
  };
  const head = new Uint8Array(12);
  head.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(head.buffer).setUint32(4, 2);
  new DataView(head.buffer).setUint32(8, objects.length);
  signal?.throwIfAborted();
  yield emit(head);
  let unstarted: AsyncIterable<Uint8Array> | undefined;
  try {
    for (const { oid, type } of order) {
      signal?.throwIfAborted();
      const p = plan.get(oid) as Plan;
      if (p.mode === "computed") {
        const data = await p.delta();
        signal?.throwIfAborted();
        yield emit(entryHeader(REF_DELTA, data.length, p.base));
        const pending: Uint8Array[] = [];
        const d = new Deflate();
        d.onData = (c: Uint8Array) => {
          pending.push(c);
        };
        d.push(data, true);
        if (d.err) throw new Error(`deflate failed: ${d.msg}`);
        for (const c of pending) yield emit(c);
        if (stats) stats.computed = (stats.computed ?? 0) + 1;
        continue;
      }
      if (p.mode !== "deflate") {
        // the CRC is checked before the first byte goes out
        const buffered = await checkedCopy(p.entry, signal).catch((e) => {
          if (e instanceof PackError) return undefined; // a bad copy: sent whole from another
          throw e;
        });
        if (buffered !== undefined) {
          yield emit(
            p.mode === "whole"
              ? entryHeader(TYPE_CODE[type], p.entry.size)
              : entryHeader(REF_DELTA, p.entry.size, p.base),
          );
          if (buffered === "large")
            for await (const c of p.entry.raw()) {
              signal?.throwIfAborted();
              yield emit(c);
            }
          else for (const c of buffered) yield emit(c);
          if (stats) {
            if (p.mode === "whole") stats.reusedWhole++;
            else if (p.mode === "delta") stats.reusedDelta++;
            else stats.thinDelta++;
          }
          continue;
        }
      }
      const o = await repo.objects.get(oid);
      if (!o) throw new Error(`object ${oid} is not in this repository`);
      if (o.type !== type) {
        await o.content[Symbol.asyncIterator]().return?.();
        throw new Error(`object ${oid} is a ${o.type}, listed as a ${type}`);
      }
      unstarted = o.content;
      yield emit(entryHeader(TYPE_CODE[o.type], o.size));
      unstarted = undefined;
      const pending: Uint8Array[] = [];
      const d = new Deflate();
      d.onData = (c: Uint8Array) => {
        pending.push(c);
      };
      let got = 0;
      for await (const c of o.content) {
        signal?.throwIfAborted();
        got += c.length;
        d.push(c, false);
        while (pending.length) yield emit(pending.shift() as Uint8Array);
      }
      if (got !== o.size) throw new Error(`object ${oid}: ${got} bytes read, ${o.size} declared`);
      d.push(new Uint8Array(0), true);
      if (d.err) throw new Error(`deflate failed: ${d.msg}`);
      while (pending.length) yield emit(pending.shift() as Uint8Array);
      if (stats) stats.deflated++;
    }
  } finally {
    if (unstarted) await unstarted[Symbol.asyncIterator]().return?.();
  }
  yield hash.digest();
}

/**
 * Reads a stored entry through, checking its CRC: its bytes when at most BUFFER_MAX, else "large"
 * (to be copied by a second read). Throws the PackError of a mismatch.
 */
async function checkedCopy(
  entry: PackedEntry,
  signal?: AbortSignal,
): Promise<Uint8Array[] | "large"> {
  let parts: Uint8Array[] | undefined = [];
  let n = 0;
  for await (const c of entry.raw()) {
    signal?.throwIfAborted();
    if (!parts) continue;
    n += c.length;
    if (n > BUFFER_MAX) parts = undefined;
    else parts.push(c.slice());
  }
  return parts ?? "large";
}

export async function* exportPackReusing(
  repo: Repository,
  wants: string[],
  haves: string[],
  opts: ReuseOptions & WalkOptions = {},
): AsyncGenerator<Uint8Array> {
  const { objects, receiverHas } = await listObjectsWithEdges(repo, wants, haves, opts);
  yield* writePackReusing(repo, objects, { ...opts, receiverHas: (oid) => receiverHas.has(oid) });
}
