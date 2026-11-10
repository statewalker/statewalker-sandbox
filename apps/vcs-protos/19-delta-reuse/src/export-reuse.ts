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
 * Copied entries are checked against their idx CRC as they stream (git checks it before reusing):
 * a mismatch fails the export with a PackError — a corrupt entry is never passed on. Deltas copied
 * from different packs can form a cycle (pack 1 stores A against B, pack 2 B against A): the
 * decisions are checked, and an object on a cycle is sent whole.
 */
import { sha1 } from "@noble/hashes/legacy.js";
import { Deflate } from "pako";
import type { PackedEntry } from "../../13-pack-reader/src/pack-reader.js";
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
}
export interface ReuseOptions {
  signal?: AbortSignal;
  /** send deltas against objects the receiver has (REF_DELTA; completed with --fix-thin) */
  thin?: boolean;
  stats?: ReuseStats;
}

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const REF_DELTA = 7;
const unhex = (h: string) =>
  Uint8Array.from(h.match(/../g) as string[], (x) => Number.parseInt(x, 16));

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

type Plan =
  | { mode: "whole"; entry: PackedEntry }
  | { mode: "delta" | "thin"; entry: PackedEntry; base: string }
  | { mode: "deflate" };

export async function* writePackReusing(
  repo: Repository,
  objects: ToSend[],
  opts: ReuseOptions & { receiverHas?: (oid: string) => boolean } = {},
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
    for (const { oid, type } of objects) {
      signal?.throwIfAborted();
      const p = plan.get(oid) as Plan;
      if (p.mode !== "deflate") {
        yield emit(
          p.mode === "whole"
            ? entryHeader(TYPE_CODE[type], p.entry.size)
            : entryHeader(REF_DELTA, p.entry.size, p.base),
        );
        // the compressed bytes as stored, CRC-checked as they stream (throws at the end on a mismatch)
        for await (const c of p.entry.raw()) {
          signal?.throwIfAborted();
          yield emit(c);
        }
        if (stats) {
          if (p.mode === "whole") stats.reusedWhole++;
          else if (p.mode === "delta") stats.reusedDelta++;
          else stats.thinDelta++;
        }
        continue;
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

export async function* exportPackReusing(
  repo: Repository,
  wants: string[],
  haves: string[],
  opts: ReuseOptions & WalkOptions = {},
): AsyncGenerator<Uint8Array> {
  const { objects, receiverHas } = await listObjectsWithEdges(repo, wants, haves, opts);
  yield* writePackReusing(repo, objects, { ...opts, receiverHas: (oid) => receiverHas.has(oid) });
}
