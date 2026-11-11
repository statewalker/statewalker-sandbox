/**
 * X13c — git's rename detection (`diffcore-rename.c` with `diffcore-delta.c`'s similarity), over a
 * diff of two trees, as `git diff-tree -r -M` gives it.
 *
 * The steps of `diffcore_rename_extended` without copies, breaks or directory renames:
 * 1. exact renames: the same blob, preferring a source with the same basename, then the first;
 *    symlinks and submodules only to the same mode;
 * 2. the basename pass: a basename unique among the remaining sources and among the remaining
 *    destinations is paired when similar enough (half way from the threshold to 100%);
 * 3. unless the rename limit is passed, the matrix: each destination keeps its 4 best sources; all
 *    candidates, sorted (stably) by score and then by the same basename, are taken best first.
 */

import { readTree } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";

export interface DiffEntry {
  status: "A" | "D" | "M" | "T" | "R" | "C";
  /** similarity percent, for renames */
  score?: number;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  oldPath: string;
  newPath: string;
}
export interface RenameOptions {
  /** minimum similarity percent (`-M<n>%`), 50 by default */
  score?: number;
  /** rename limit (`-l<n>`): no inexact detection past limit² candidate pairs; ≤ 0 unlimited */
  limit?: number;
  /** empty files can be renames (diff's default; merge-ort turns it off) */
  renameEmpty?: boolean;
}

export const MAX_SCORE = 60000;
const NULL_OID = "0".repeat(40);
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const NUM_CANDIDATE_PER_DST = 4;
const HASHBASE = 107927;

interface Entry {
  mode: string;
  oid: string;
}

const isTree = (mode: string) => /^0*40000$/.test(mode);
const fullMode = (mode: string) => mode.padStart(6, "0");
const isRegular = (mode: string) => mode === "100644" || mode === "100755";
const fileType = (mode: string) => (isRegular(mode) ? "reg" : mode);
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** byte order of UTF-8 paths, which is tree order for full paths of files */
const enc = new TextEncoder();
const isAscii = (s: string) => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
};
function comparePaths(a: string, b: string): number {
  if (isAscii(a) && isAscii(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = enc.encode(a);
  const y = enc.encode(b);
  for (let i = 0; i < x.length && i < y.length; i++)
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
}

async function flatten(repo: Repository, oid: string | undefined): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  if (!oid) return out;
  const walk = async (tree: string, prefix: string) => {
    for (const e of await readTree(repo, tree)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (isTree(e.mode)) await walk(e.oid, path);
      else out.set(path, { mode: fullMode(e.mode), oid: e.oid });
    }
  };
  await walk(oid, "");
  return out;
}

async function readBlob(repo: Repository, oid: string): Promise<Uint8Array> {
  const o = await repo.objects.get(oid);
  if (!o) throw new Error(`missing blob ${oid}`);
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of o.content) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `buffer_is_binary`: a NUL in the first 8000 bytes */
function isBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

/**
 * `hash_chars`: chunks ending at LF or 64 bytes long (CR before LF dropped in text; bytes after the
 * last chunk end are not counted), hashed into 107927 values; the sorted values and their byte counts.
 */
export function spanHashes(data: Uint8Array): { hash: Uint32Array; count: Uint32Array } {
  const text = !isBinary(data);
  const counts = new Map<number, number>();
  let n = 0;
  let accum1 = 0;
  let accum2 = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as number;
    if (text && c === 13 && i + 1 < data.length && data[i + 1] === 10) continue;
    const old1 = accum1;
    accum1 = ((accum1 << 7) ^ (accum2 >>> 25)) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    accum1 = (accum1 + c) >>> 0;
    if (++n < 64 && c !== 10) continue;
    const h = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
    counts.set(h, (counts.get(h) ?? 0) + n);
    n = 0;
    accum1 = accum2 = 0;
  }
  const keys = [...counts.keys()].sort((a, b) => a - b);
  return {
    hash: Uint32Array.from(keys),
    count: Uint32Array.from(keys, (k) => counts.get(k) as number),
  };
}

/** `diffcore_count_changes`: bytes of the source found again in the destination */
export function sourceCopied(
  src: { hash: Uint32Array; count: Uint32Array },
  dst: { hash: Uint32Array; count: Uint32Array },
): number {
  let copied = 0;
  let d = 0;
  for (let s = 0; s < src.hash.length; s++) {
    const h = src.hash[s] as number;
    while (d < dst.hash.length && (dst.hash[d] as number) < h) d++;
    const sc = src.count[s] as number;
    let dc = 0;
    if (d < dst.hash.length && dst.hash[d] === h) dc = dst.count[d++] as number;
    copied += sc < dc ? sc : dc;
  }
  return copied;
}

/** a file in the rename search, with its content loaded on demand */
interface Spec {
  path: string;
  mode: string;
  oid: string;
  pair: number;
  used: boolean;
}

/** the minimum score in MAX_SCORE units, as `parse_rename_score` reads `<n>%` */
function minimumScore(percent: number | undefined): number {
  const p = percent ?? 50;
  if (p >= 100) return MAX_SCORE;
  const s = Math.floor((MAX_SCORE * p) / 100);
  return s > 0 ? s : MAX_SCORE / 2;
}

interface Pair {
  path: string;
  old?: Entry;
  new?: Entry;
}

/**
 * The renames among the deletions and additions of `pairs`: for each destination (an index into
 * `pairs`), its source pair and score (MAX_SCORE units).
 */
export async function findRenames(
  repo: Repository,
  pairs: Pair[],
  opts: RenameOptions = {},
): Promise<Map<number, { src: number; score: number }>> {
  const minimum = minimumScore(opts.score);
  const renameEmpty = opts.renameEmpty ?? true;
  const limit = opts.limit ?? 1000;
  let srcs: Spec[] = [];
  const dsts: (Spec & { rename?: { src: Spec; score: number } })[] = [];
  pairs.forEach((p, i) => {
    if (!p.old && p.new) {
      if (renameEmpty || p.new.oid !== EMPTY_BLOB)
        dsts.push({ path: p.path, ...p.new, pair: i, used: false });
    } else if (p.old && !p.new) {
      if (renameEmpty || p.old.oid !== EMPTY_BLOB)
        srcs.push({ path: p.path, ...p.old, pair: i, used: false });
    }
  });
  const result = new Map<number, { src: number; score: number }>();
  if (!dsts.length || !srcs.length) return result;

  const record = (dst: (typeof dsts)[number], src: Spec, score: number) => {
    src.used = true;
    dst.rename = { src, score };
    result.set(dst.pair, { src: src.pair, score });
  };

  // exact renames: sources by blob, in order
  const byOid = new Map<string, Spec[]>();
  for (const s of srcs) {
    const list = byOid.get(s.oid);
    if (list) list.push(s);
    else byOid.set(s.oid, [s]);
  }
  for (const dst of dsts) {
    let best: Spec | undefined;
    let bestScore = -1;
    let tries = 100;
    for (const src of byOid.get(dst.oid) ?? []) {
      if ((!isRegular(src.mode) || !isRegular(dst.mode)) && src.mode !== dst.mode) continue;
      if (src.used) continue;
      const score = 1 + (basename(src.path) === basename(dst.path) ? 1 : 0);
      if (score > bestScore) {
        best = src;
        bestScore = score;
        if (score === 2) break;
      }
      if (!--tries) break;
    }
    if (best) record(dst, best, MAX_SCORE);
  }
  if (minimum === MAX_SCORE) return result;

  // content, sizes and span hashes, loaded once
  const blobs = new Map<string, Uint8Array>();
  const hashes = new Map<string, ReturnType<typeof spanHashes>>();
  const blob = async (oid: string) => {
    const known = blobs.get(oid);
    if (known) return known;
    const b = await readBlob(repo, oid);
    blobs.set(oid, b);
    return b;
  };
  const spans = (oid: string, data: Uint8Array) => {
    const known = hashes.get(oid);
    if (known) return known;
    const h = spanHashes(data);
    hashes.set(oid, h);
    return h;
  };
  const similarity = async (src: Spec, dst: Spec, min: number): Promise<number> => {
    if (!isRegular(src.mode) || !isRegular(dst.mode)) return 0;
    const a = await blob(src.oid);
    const b = await blob(dst.oid);
    const max = Math.max(a.length, b.length);
    const delta = max - Math.min(a.length, b.length);
    if (max * (MAX_SCORE - min) < delta * MAX_SCORE) return 0;
    const ha = spans(src.oid, a);
    const hb = spans(dst.oid, b);
    if (!b.length) return 0;
    return Math.floor((sourceCopied(ha, hb) * MAX_SCORE) / max);
  };

  // basenames unique on both sides
  srcs = srcs.filter((s) => !s.used);
  const minBasename = minimum + Math.floor(0.5 * (MAX_SCORE - minimum));
  const unique = <T extends Spec>(list: T[]) => {
    const m = new Map<string, T | null>();
    for (const s of list) {
      const b = basename(s.path);
      m.set(b, m.has(b) ? null : s);
    }
    return m;
  };
  const srcByBase = unique(srcs);
  const dstByBase = unique(dsts.filter((d) => !d.rename));
  for (const src of srcs) {
    const b = basename(src.path);
    if (!dstByBase.has(b)) continue;
    const dst = dstByBase.get(b);
    if (!dst || srcByBase.get(b) !== src) continue; // not unique: no directory-rename guess here
    if (dst.rename) continue;
    const score = await similarity(src, dst, minBasename);
    if (score < minBasename) continue;
    record(dst, src, score);
  }
  srcs = srcs.filter((s) => !s.used);

  const left = dsts.filter((d) => !d.rename);
  if (!left.length || !srcs.length) return result;
  if (limit > 0 && left.length * srcs.length > limit * limit) return result;

  // the matrix: 4 best candidates per destination
  interface Score {
    dst: number;
    src: number;
    score: number;
    name: number;
  }
  const compare = (a: Score, b: Score) => {
    if (a.dst < 0) return b.dst >= 0 ? 1 : 0;
    if (b.dst < 0) return -1;
    if (a.score === b.score) return b.name - a.name;
    return b.score - a.score;
  };
  const mx: Score[] = [];
  for (const [di, dst] of left.entries()) {
    const m: Score[] = Array.from({ length: NUM_CANDIDATE_PER_DST }, () => ({
      dst: -1,
      src: -1,
      score: 0,
      name: 0,
    }));
    for (const [si, src] of srcs.entries()) {
      const o: Score = {
        dst: di,
        src: si,
        score: await similarity(src, dst, minimum),
        name: basename(src.path) === basename(dst.path) ? 1 : 0,
      };
      let worst = 0;
      for (let i = 1; i < NUM_CANDIDATE_PER_DST; i++)
        if (compare(m[i] as Score, m[worst] as Score) > 0) worst = i;
      if (compare(m[worst] as Score, o) > 0) m[worst] = o;
    }
    mx.push(...m);
  }
  mx.sort(compare);
  for (const c of mx) {
    if (c.dst < 0 || c.score < minimum) break;
    const dst = left[c.dst] as (typeof dsts)[number];
    const src = srcs[c.src] as Spec;
    if (dst.rename || src.used) continue;
    record(dst, src, c.score);
  }
  return result;
}

/** `git diff-tree -r -M`: the changes from tree `a` to tree `b`, renames found as git finds them */
export async function diffTrees(
  repo: Repository,
  a: string | undefined,
  b: string | undefined,
  opts: RenameOptions = {},
): Promise<DiffEntry[]> {
  const [x, y] = await Promise.all([flatten(repo, a), flatten(repo, b)]);
  const paths = [...new Set([...x.keys(), ...y.keys()])].sort(comparePaths);
  const pairs: Pair[] = [];
  const changes: DiffEntry[] = [];
  for (const path of paths) {
    const o = x.get(path);
    const n = y.get(path);
    if (o && n && o.mode === n.mode && o.oid === n.oid) continue;
    pairs.push({ path, old: o, new: n });
    changes.push({
      status: !o ? "A" : !n ? "D" : fileType(o.mode) !== fileType(n.mode) ? "T" : "M",
      oldMode: o?.mode ?? "000000",
      newMode: n?.mode ?? "000000",
      oldOid: o?.oid ?? NULL_OID,
      newOid: n?.oid ?? NULL_OID,
      oldPath: path,
      newPath: path,
    });
  }
  const renames = await findRenames(repo, pairs, opts);
  const usedSources = new Set([...renames.values()].map((r) => r.src));
  const out: DiffEntry[] = [];
  changes.forEach((c, i) => {
    const r = renames.get(i);
    if (r) {
      const s = changes[r.src] as DiffEntry;
      out.push({
        ...c,
        status: "R",
        score: Math.floor((r.score * 100) / MAX_SCORE),
        oldMode: s.oldMode,
        oldOid: s.oldOid,
        oldPath: s.oldPath,
      });
    } else if (!usedSources.has(i)) out.push(c);
  });
  return out;
}
