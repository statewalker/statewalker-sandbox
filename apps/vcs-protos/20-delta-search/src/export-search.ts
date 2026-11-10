/**
 * X6e — delta search in export, as git's pack-objects (find_deltas/try_delta) and JGit's
 * DeltaWindow do, on top of X6d's reuse:
 *
 *  - candidates: the objects X6d would send whole (stored whole in a pack, or loose); reused
 *    deltas keep their base and are neither targets nor bases (git skips them too). Objects above
 *    `bigFileThreshold` are never loaded nor delta'd.
 *  - thin: the receiver's objects at the paths being sent (the edge commits' trees) join as
 *    preferred bases — bases only, never sent (git's add_preferred_base).
 *  - order (git's type_size_sort): type, path hash (`pack_name_hash`) and size descending, then
 *    the walk's order; each candidate is tried against the `window` objects before it, most recent
 *    first, stopping at another type.
 *  - bounds (git's try_delta): a delta must be smaller than half the target minus 20 bytes, or
 *    than the best found so far, scaled by the base's depth; no base at `depth`; no target under
 *    1/32 of the base. The encoder gives up as soon as the bound is passed.
 *  - memory: the window holds contents (and their block index) up to `windowMemory` plus the
 *    current target; computed deltas are kept up to git's delta cache rules and otherwise
 *    recomputed when written.
 *
 * Deviations from git's defaults for bounded memory on every runtime (a Durable Object has
 * 128 MiB): `windowMemory` 32 MiB (git: unlimited), `bigFileThreshold` 16 MiB (git: 512 MiB),
 * `deltaCacheSize` 16 MiB (git: 256 MiB). git's check_delta_limit is applied: a candidate's reused
 * delta descendants lower the depth it may take; `depth` bounds the whole pack.
 */

import { PackError } from "../../13-pack-reader/src/pack-reader.js";
import { readCommit, readTree } from "../../17-repository/src/commands.js";
import { isTreeMode } from "../../17-repository/src/git-format.js";
import type { ObjectType, Repository } from "../../17-repository/src/object-store.js";
import {
  listObjectsWithEdges,
  type ToSend,
  type WalkOptions,
} from "../../18-pack-export/src/export.js";
import {
  MAX_DEPTH,
  type Plan,
  type ReuseOptions,
  TYPE_CODE,
  writePackReusing,
} from "../../19-delta-reuse/src/export-reuse.js";
import {
  type DeltaIndex,
  deltaIndex,
  encodeDelta,
  indexBytes,
  indexEstimate,
} from "./delta-encode.js";

export interface SearchStats {
  candidates: number;
  computed: number;
  comparisons: number;
  /** content (and index) bytes the window held at most, the current target included */
  peakWindowBytes: number;
  /** candidates above bigFileThreshold (never delta'd, never buffered) */
  big: number;
}
export interface SearchOptions extends ReuseOptions {
  /** objects each candidate is tried against (git's --window). Default 10. */
  window?: number;
  /** maximum chain depth (git's --depth). Default 50. */
  depth?: number;
  /** content bytes the window may hold (git's --window-memory). Default 32 MiB; 0: unlimited. */
  windowMemory?: number;
  /** objects larger than this are sent without delta search. Default 16 MiB. */
  bigFileThreshold?: number;
  /** computed deltas kept until written (git's pack.deltaCacheSize). Default 16 MiB. */
  deltaCacheSize?: number;
  searchStats?: SearchStats;
  /** called as candidates are searched (git's "Compressing objects: i/n") */
  onProgress?: (done: number, total: number) => void;
}

const enc = new TextEncoder();
/** git's isspace (sane_ctype): tab, newline, carriage return and space */
const SPACE = new Set([9, 10, 13, 32]);

/** git's pack_name_hash: the last characters weigh most, so same-named files sort together. */
export function nameHash(path: string): number {
  let h = 0;
  for (const c of enc.encode(path)) {
    if (SPACE.has(c)) continue;
    h = ((h >>> 2) + ((c << 24) >>> 0)) >>> 0;
  }
  return h;
}

interface Candidate {
  oid: string;
  type: ObjectType;
  hash: number;
  size: number;
  preferred: boolean;
  order: number;
}
interface WindowEntry {
  c: Candidate;
  data: Uint8Array;
  index?: DeltaIndex;
  depth: number;
}

async function readAll(s: AsyncIterable<Uint8Array>, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let o = 0;
  for await (const c of s) {
    if (o + c.length > size) throw new Error("object longer than declared");
    out.set(c, o);
    o += c.length;
  }
  if (o !== size) throw new Error("object shorter than declared");
  return out;
}

/** git's delta_cacheable (pack.deltaCacheLimit 1000). */
const cacheable = (srcSize: number, trgSize: number, deltaSize: number) =>
  deltaSize < 1000 ||
  Math.floor(srcSize / 2 ** 20) + Math.floor(trgSize / 2 ** 21) > deltaSize >> 10;

export async function* writePackSearching(
  repo: Repository,
  objects: ToSend[],
  opts: SearchOptions & { receiverHas?: (oid: string) => boolean; edges?: string[] } = {},
): AsyncGenerator<Uint8Array> {
  const window = opts.window ?? 10;
  const maxDepth = opts.depth ?? MAX_DEPTH;
  const windowMemory = opts.windowMemory ?? 32 * 2 ** 20;
  const bigFile = opts.bigFileThreshold ?? 16 * 2 ** 20;
  const deltaCacheSize = opts.deltaCacheSize ?? 16 * 2 ** 20;
  const st = opts.searchStats;
  const signal = opts.signal;
  if (!(Number.isInteger(window) && window >= 0)) throw new Error(`bad window ${window}`);
  if (!(Number.isInteger(maxDepth) && maxDepth >= 1 && maxDepth <= MAX_DEPTH))
    throw new Error(`depth must be 1…${MAX_DEPTH}: ${maxDepth}`);

  const refine = async (plan: Map<string, Plan>) => {
    if (window === 0) return;
    const sending = new Set(objects.map((o) => o.oid));
    const cands: Candidate[] = [];
    const sizeOf = async (oid: string, p: Plan | undefined): Promise<number | undefined> => {
      if (p?.mode === "whole") return p.entry.size;
      const o = await repo.objects.get(oid);
      if (!o) return undefined;
      await o.content[Symbol.asyncIterator]().return?.();
      return o.size;
    };
    let order = 0;
    for (const o of objects) {
      signal?.throwIfAborted();
      const p = plan.get(o.oid);
      if (p?.mode !== "whole" && p?.mode !== "deflate") continue;
      const size = await sizeOf(o.oid, p).catch((e) => {
        if (e instanceof PackError) return undefined; // left to the writer (another copy, or fail)
        throw e;
      });
      if (size === undefined) continue;
      if (size > bigFile) {
        if (st) st.big++;
        continue;
      }
      cands.push({
        oid: o.oid,
        type: o.type,
        hash: nameHash(o.path ?? ""),
        size,
        preferred: false,
        order: order++,
      });
    }
    // thin: the receiver's objects at the sent paths, as bases only
    if (opts.thin && opts.receiverHas && opts.edges?.length) {
      const wanted = new Set<string>();
      const dirs = new Set<string>([""]);
      for (const o of objects) {
        if (o.type !== "tree" && o.type !== "blob") continue;
        const path = o.path ?? "";
        wanted.add(path);
        for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1))
          dirs.add(path.slice(0, i));
      }
      const seen = new Set<string>();
      const add = async (oid: string, type: ObjectType, path: string) => {
        if (seen.has(oid) || sending.has(oid) || !opts.receiverHas?.(oid)) return;
        seen.add(oid);
        const size = await sizeOf(oid, undefined).catch(() => undefined);
        if (size === undefined || size > bigFile) return;
        cands.push({ oid, type, hash: nameHash(path), size, preferred: true, order: order++ });
      };
      const walk = async (tree: string, path: string) => {
        signal?.throwIfAborted();
        if (wanted.has(path)) await add(tree, "tree", path);
        for (const e of await readTree(repo, tree)) {
          if (Number.parseInt(e.mode, 8) === 0o160000) continue;
          const p = path ? `${path}/${e.name}` : e.name;
          if (isTreeMode(e.mode)) {
            if (dirs.has(p) || wanted.has(p)) await walk(e.oid, p);
          } else if (wanted.has(p)) await add(e.oid, "blob", p);
        }
      };
      for (const c of opts.edges) await walk((await readCommit(repo, c)).tree, "");
    }
    // git's type_size_sort
    cands.sort(
      (a, b) =>
        TYPE_CODE[b.type] - TYPE_CODE[a.type] ||
        b.hash - a.hash ||
        Number(b.preferred) - Number(a.preferred) ||
        b.size - a.size ||
        a.order - b.order,
    );
    if (st) st.candidates += cands.length;
    // git's check_delta_limit: a candidate's reused-delta descendants lower the depth it may take
    const children = new Map<string, string[]>();
    for (const [oid, p] of plan)
      if (p.mode === "delta") {
        const list = children.get(p.base);
        if (list) list.push(oid);
        else children.set(p.base, [oid]);
      }
    const below = new Map<string, number>();
    const descendants = (oid: string, seen: number): number => {
      const known = below.get(oid);
      if (known !== undefined) return known;
      let d = 0;
      if (seen <= maxDepth)
        // chains past the limit are cut by the writer anyway
        for (const c of children.get(oid) ?? []) d = Math.max(d, 1 + descendants(c, seen + 1));
      below.set(oid, d);
      return d;
    };

    const win: WindowEntry[] = [];
    let winBytes = 0;
    const bytesOf = (w: WindowEntry) => w.data.length + (w.index ? indexBytes(w.index) : 0);
    let cached = 0;
    let done = 0;
    for (const c of cands) {
      signal?.throwIfAborted();
      opts.onProgress?.(done++, cands.length);
      // verified: a copy that inflates to wrong bytes is not used as a base; an unreadable copy
      // leaves the object to the writer (another copy, or a failure before its entry starts)
      let data: Uint8Array;
      try {
        const o = await repo.objects.get(c.oid, { verify: true });
        if (!o) throw new Error(`object ${c.oid} is not in this repository`);
        if (o.type !== c.type) {
          await o.content[Symbol.asyncIterator]().return?.();
          throw new Error(`object ${c.oid} is a ${o.type}, listed as a ${c.type}`);
        }
        data = await readAll(o.content, o.size);
      } catch (e) {
        if (e instanceof PackError) continue;
        throw e;
      }
      if (st) st.peakWindowBytes = Math.max(st.peakWindowBytes, winBytes + data.length);
      let best: { base: WindowEntry; delta: Uint8Array; depth: number } | undefined;
      const cMax = maxDepth - (c.preferred ? 0 : descendants(c.oid, 0));
      if (!c.preferred && cMax > 0) {
        for (let j = win.length - 1; j >= 0; j--) {
          const w = win[j] as WindowEntry;
          if (w.c.type !== c.type) break; // sorted by type: nothing further back matches
          if (w.depth >= cMax) continue;
          // git's try_delta: the bound, scaled by the base's depth, is what the encoder gets
          let max = best ? best.delta.length : Math.floor(c.size / 2) - 20;
          const refDepth = best ? best.depth : 1;
          max = Math.floor((max * (cMax - w.depth)) / (cMax - refDepth + 1));
          if (max <= 0) continue;
          const sizeDiff = w.c.size < c.size ? c.size - w.c.size : 0;
          if (sizeDiff >= max) continue;
          if (c.size < w.c.size / 32) continue;
          if (st) st.comparisons++;
          const d = encodeDelta(w.index as DeltaIndex, data, max);
          if (!d) continue;
          // a same-sized delta only wins with a shallower base
          if (best && d.length === best.delta.length && w.depth + 1 >= best.depth) continue;
          best = { base: w, delta: d, depth: w.depth + 1 };
        }
      }
      if (best) {
        const base = best.base.c.oid;
        const target = c.oid;
        let delta: () => Promise<Uint8Array>;
        if (
          cached + best.delta.length <= deltaCacheSize &&
          cacheable(best.base.c.size, c.size, best.delta.length)
        ) {
          const bytes = best.delta;
          cached += bytes.length;
          delta = async () => bytes;
        } else {
          // recomputed when written (git does the same for deltas it does not cache)
          delta = async () => {
            const read = async (oid: string) => {
              const x = await repo.objects.get(oid);
              if (!x) throw new Error(`object ${oid} vanished`);
              return readAll(x.content, x.size);
            };
            return encodeDelta(deltaIndex(await read(base)), await read(target)) as Uint8Array;
          };
        }
        plan.set(c.oid, { mode: "computed", base, delta });
        if (st) st.computed++;
      }
      // room is made before the entry is indexed (git indexes lazily but counts the index too),
      // so the window never holds more than windowMemory; an entry that alone would exceed it is
      // not kept (it cannot be a base)
      const need = data.length + indexEstimate(data.length);
      if (windowMemory > 0 && need > windowMemory) continue;
      while (
        win.length >= window ||
        (windowMemory > 0 && win.length && winBytes + need > windowMemory)
      )
        winBytes -= bytesOf(win.shift() as WindowEntry);
      const entry: WindowEntry = { c, data, index: deltaIndex(data), depth: best ? best.depth : 0 };
      win.push(entry);
      winBytes += bytesOf(entry);
      if (st) st.peakWindowBytes = Math.max(st.peakWindowBytes, winBytes);
    }
    opts.onProgress?.(done, cands.length);
  };
  yield* writePackReusing(repo, objects, { ...opts, depth: maxDepth, refine });
}

export async function* exportPackSearching(
  repo: Repository,
  wants: string[],
  haves: string[],
  opts: SearchOptions & WalkOptions = {},
): AsyncGenerator<Uint8Array> {
  const { objects, edges, receiverHas } = await listObjectsWithEdges(repo, wants, haves, opts);
  yield* writePackSearching(repo, objects, {
    ...opts,
    edges,
    receiverHas: (oid) => receiverHas.has(oid),
  });
}
