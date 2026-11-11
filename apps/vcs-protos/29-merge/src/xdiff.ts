/**
 * X13a — git's xdiff (v2.43.0), ported for exact results: what `git merge-tree` computes with
 * `merge-ort`'s settings (histogram diff, no whitespace flags, no indent heuristic).
 *
 *  - xprepare.c: records are lines with their `\n`; each distinct line gets a class (its index in
 *    order of first appearance), and only classes are compared. The classic algorithm also trims
 *    the common ends and discards lines that cannot match or match too often (`xdl_cleanup_records`)
 *    — histogram does neither.
 *  - xhistogram.c: histogram diff, falling back to the classic algorithm when a region's lines
 *    repeat more than 64 times.
 *  - xdiffi.c: the classic algorithm (Myers' divide and conquer with git's cost heuristics),
 *    `xdl_change_compact` (slides groups of changes, aligning them with the other side's) and
 *    `xdl_build_script`.
 *
 * Indices follow the C: records are 0-based, `rchg` has a sentinel on each side (`rchg[i + 1]`
 * here is the C's `rchg[i]`), histogram lines are 1-based.
 */

/** one side of a diff: its lines and which of them changed */
export interface XdFile {
  /** the bytes all records point into */
  data: Uint8Array;
  /** record i is data[start[i], end[i]) — a line with its `\n` (the last one may have none) */
  start: number[];
  end: number[];
  /** each record's class: equal lines, equal classes */
  ha: number[];
  nrec: number;
  /** changed flags, offset by one: rchg[i + 1] is record i's; rchg[0] and rchg[nrec + 1] are 0 */
  rchg: Uint8Array;
  dstart: number;
  dend: number;
}
export interface XdEnv {
  xdf1: XdFile;
  xdf2: XdFile;
}
/** a change: lines [i1, i1 + chg1) of side 1 became lines [i2, i2 + chg2) of side 2 */
export interface XdChange {
  i1: number;
  i2: number;
  chg1: number;
  chg2: number;
}

const XDL_MAX_COST_MIN = 256;
const XDL_HEUR_MIN_COST = 256;
const XDL_LINE_MAX = Number.MAX_SAFE_INTEGER;
const XDL_SNAKE_CNT = 20;
const XDL_K_HEUR = 4;
const XDL_KPDIS_RUN = 4;
const XDL_MAX_EQLIMIT = 1024;
const XDL_SIMSCAN_WINDOW = 100;

export function xdlBogosqrt(n: number): number {
  let i = 1;
  for (; n > 0; n = Math.floor(n / 4)) i *= 2;
  return i;
}
export function xdlHashbits(size: number): number {
  let val = 1;
  let bits = 0;
  for (; val < size && bits < 32; val *= 2, bits++);
  return bits ? bits : 1;
}
/** XDL_HASHLONG(v, b) */
function hashlong(v: number, b: number): number {
  return (v + Math.floor(v / 2 ** b)) & ((1 << b) - 1);
}

/**
 * Histogram's limit (64 distinct lines in one hash bucket): git fails the merge there too
 * ("failed to execute internal merge"); a caller reports it as git does.
 */
export class XdiffLimitError extends Error {
  override name = "XdiffLimitError";
}

/**
 * A lossless string key for a line's bytes: `TextDecoder("latin1")` (WHATWG windows-1252, which
 * maps every byte to a distinct code point), or char codes where a runtime lacks it.
 */
const lineKey: (bytes: Uint8Array) => string = (() => {
  try {
    const d = new TextDecoder("latin1");
    return (b: Uint8Array) => d.decode(b);
  } catch {
    return (b: Uint8Array) => {
      let s = "";
      for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
      return s;
    };
  }
})();

/** splits `data` into records (lines keeping their `\n`) */
function records(data: Uint8Array): { start: number[]; end: number[] } {
  const start: number[] = [];
  const end: number[] = [];
  let at = 0;
  while (at < data.length) {
    const nl = data.indexOf(10, at);
    const e = nl < 0 ? data.length : nl + 1;
    start.push(at);
    end.push(e);
    at = e;
  }
  return { start, end };
}

interface Classifier {
  /** line → class */
  classes: Map<string, number>;
  /** per class: how many lines of side 1 and of side 2 */
  len1: number[];
  len2: number[];
}

function prepareCtx(pass: 1 | 2, data: Uint8Array, cf: Classifier): XdFile {
  const { start, end } = records(data);
  const ha: number[] = new Array(start.length);
  for (let i = 0; i < start.length; i++) {
    const key = lineKey(data.subarray(start[i] as number, end[i] as number));
    let c = cf.classes.get(key);
    if (c === undefined) {
      c = cf.classes.size;
      cf.classes.set(key, c);
      cf.len1.push(0);
      cf.len2.push(0);
    }
    if (pass === 1) cf.len1[c] = (cf.len1[c] as number) + 1;
    else cf.len2[c] = (cf.len2[c] as number) + 1;
    ha[i] = c;
  }
  return {
    data,
    start,
    end,
    ha,
    nrec: start.length,
    rchg: new Uint8Array(start.length + 2),
    dstart: 0,
    dend: start.length - 1,
  };
}

/** the classic algorithm's view: the records it compares (after trimming and discards) */
interface DiffData {
  nrec: number;
  ha: number[];
  rindex: number[];
  rchg: Uint8Array;
}

function cleanMmatch(dis: Uint8Array, i: number, s: number, e: number): boolean {
  if (i - s > XDL_SIMSCAN_WINDOW) s = i - XDL_SIMSCAN_WINDOW;
  if (e - i > XDL_SIMSCAN_WINDOW) e = i + XDL_SIMSCAN_WINDOW;
  let r: number;
  let rdis0 = 0;
  let rpdis0 = 1;
  for (r = 1; i - r >= s; r++) {
    const d = dis[i - r];
    if (!d) rdis0++;
    else if (d === 2) rpdis0++;
    else break;
  }
  if (rdis0 === 0) return false;
  let rdis1 = 0;
  let rpdis1 = 1;
  for (r = 1; i + r <= e; r++) {
    const d = dis[i + r];
    if (!d) rdis1++;
    else if (d === 2) rpdis1++;
    else break;
  }
  if (rdis1 === 0) return false;
  rdis1 += rdis0;
  rpdis1 += rpdis0;
  return rpdis1 * XDL_KPDIS_RUN < rpdis1 + rdis1;
}

/** xdl_trim_ends + xdl_cleanup_records: the records the classic algorithm compares */
function optimize(cf: Classifier, x1: XdFile, x2: XdFile): [DiffData, DiffData] {
  // trim the common ends
  const lim0 = Math.min(x1.nrec, x2.nrec);
  let i = 0;
  for (; i < lim0; i++) if (x1.ha[i] !== x2.ha[i]) break;
  x1.dstart = x2.dstart = i;
  let lim = lim0 - i;
  let j = 0;
  for (; j < lim; j++) if (x1.ha[x1.nrec - 1 - j] !== x2.ha[x2.nrec - 1 - j]) break;
  x1.dend = x1.nrec - j - 1;
  x2.dend = x2.nrec - j - 1;
  void lim;
  lim = 0;
  // discard lines that cannot match, or match too often amid lines that cannot
  const side = (x: XdFile, other: number[]): DiffData => {
    const dis = new Uint8Array(x.nrec + 1);
    let mlim = xdlBogosqrt(x.nrec);
    if (mlim > XDL_MAX_EQLIMIT) mlim = XDL_MAX_EQLIMIT;
    for (let k = x.dstart; k <= x.dend; k++) {
      const nm = other[x.ha[k] as number] ?? 0;
      dis[k] = nm === 0 ? 0 : nm >= mlim ? 2 : 1;
    }
    const ha: number[] = [];
    const rindex: number[] = [];
    for (let k = x.dstart; k <= x.dend; k++) {
      if (dis[k] === 1 || (dis[k] === 2 && !cleanMmatch(dis, k, x.dstart, x.dend))) {
        rindex.push(k);
        ha.push(x.ha[k] as number);
      } else x.rchg[k + 1] = 1;
    }
    return { nrec: ha.length, ha, rindex, rchg: x.rchg };
  };
  return [side(x1, cf.len2), side(x2, cf.len1)];
}

interface Split {
  i1: number;
  i2: number;
  minLo: boolean;
  minHi: boolean;
}
interface AlgoEnv {
  mxcost: number;
  snakeCnt: number;
  heurMin: number;
}

/** xdl_split: the middle snake (with git's heuristics) of ha1[off1, lim1) and ha2[off2, lim2) */
function split(
  ha1: number[],
  off1: number,
  lim1: number,
  ha2: number[],
  off2: number,
  lim2: number,
  kvdf: Float64Array,
  kvdb: Float64Array,
  base: number,
  needMin: boolean,
  spl: Split,
  xenv: AlgoEnv,
): number {
  const dmin = off1 - lim2;
  const dmax = lim1 - off2;
  const fmid = off1 - off2;
  const bmid = lim1 - lim2;
  const odd = (fmid - bmid) & 1;
  let fmin = fmid;
  let fmax = fmid;
  let bmin = bmid;
  let bmax = bmid;
  const F = (d: number) => kvdf[d + base] as number;
  const B = (d: number) => kvdb[d + base] as number;
  kvdf[fmid + base] = off1;
  kvdb[bmid + base] = lim1;
  for (let ec = 1; ; ec++) {
    let gotSnake = false;
    if (fmin > dmin) kvdf[--fmin - 1 + base] = -1;
    else ++fmin;
    if (fmax < dmax) kvdf[++fmax + 1 + base] = -1;
    else --fmax;
    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = F(d - 1) >= F(d + 1) ? F(d - 1) + 1 : F(d + 1);
      const prev1 = i1;
      let i2 = i1 - d;
      for (; i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]; i1++, i2++);
      if (i1 - prev1 > xenv.snakeCnt) gotSnake = true;
      kvdf[d + base] = i1;
      if (odd && bmin <= d && d <= bmax && B(d) <= i1) {
        spl.i1 = i1;
        spl.i2 = i2;
        spl.minLo = spl.minHi = true;
        return ec;
      }
    }
    if (bmin > dmin) kvdb[--bmin - 1 + base] = XDL_LINE_MAX;
    else ++bmin;
    if (bmax < dmax) kvdb[++bmax + 1 + base] = XDL_LINE_MAX;
    else --bmax;
    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = B(d - 1) < B(d + 1) ? B(d - 1) : B(d + 1) - 1;
      const prev1 = i1;
      let i2 = i1 - d;
      for (; i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]; i1--, i2--);
      if (prev1 - i1 > xenv.snakeCnt) gotSnake = true;
      kvdb[d + base] = i1;
      if (!odd && fmin <= d && d <= fmax && i1 <= F(d)) {
        spl.i1 = i1;
        spl.i2 = i2;
        spl.minLo = spl.minHi = true;
        return ec;
      }
    }
    if (needMin) continue;
    if (gotSnake && ec > xenv.heurMin) {
      let best = 0;
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d > fmid ? d - fmid : fmid - d;
        const i1 = F(d);
        const i2 = i1 - d;
        const v = i1 - off1 + (i2 - off2) - dd;
        if (
          v > XDL_K_HEUR * ec &&
          v > best &&
          off1 + xenv.snakeCnt <= i1 &&
          i1 < lim1 &&
          off2 + xenv.snakeCnt <= i2 &&
          i2 < lim2
        ) {
          for (let k = 1; ha1[i1 - k] === ha2[i2 - k]; k++)
            if (k === xenv.snakeCnt) {
              best = v;
              spl.i1 = i1;
              spl.i2 = i2;
              break;
            }
        }
      }
      if (best > 0) {
        spl.minLo = true;
        spl.minHi = false;
        return ec;
      }
      best = 0;
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d > bmid ? d - bmid : bmid - d;
        const i1 = B(d);
        const i2 = i1 - d;
        const v = lim1 - i1 + (lim2 - i2) - dd;
        if (
          v > XDL_K_HEUR * ec &&
          v > best &&
          off1 < i1 &&
          i1 <= lim1 - xenv.snakeCnt &&
          off2 < i2 &&
          i2 <= lim2 - xenv.snakeCnt
        ) {
          for (let k = 0; ha1[i1 + k] === ha2[i2 + k]; k++)
            if (k === xenv.snakeCnt - 1) {
              best = v;
              spl.i1 = i1;
              spl.i2 = i2;
              break;
            }
        }
      }
      if (best > 0) {
        spl.minLo = false;
        spl.minHi = true;
        return ec;
      }
    }
    if (ec >= xenv.mxcost) {
      let fbest = -1;
      let fbest1 = -1;
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = Math.min(F(d), lim1);
        let i2 = i1 - d;
        if (lim2 < i2) {
          i1 = lim2 + d;
          i2 = lim2;
        }
        if (fbest < i1 + i2) {
          fbest = i1 + i2;
          fbest1 = i1;
        }
      }
      let bbest = XDL_LINE_MAX;
      let bbest1 = XDL_LINE_MAX;
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = Math.max(off1, B(d));
        let i2 = i1 - d;
        if (i2 < off2) {
          i1 = off2 + d;
          i2 = off2;
        }
        if (i1 + i2 < bbest) {
          bbest = i1 + i2;
          bbest1 = i1;
        }
      }
      if (lim1 + lim2 - bbest < fbest - (off1 + off2)) {
        spl.i1 = fbest1;
        spl.i2 = fbest - fbest1;
        spl.minLo = true;
        spl.minHi = false;
      } else {
        spl.i1 = bbest1;
        spl.i2 = bbest - bbest1;
        spl.minLo = false;
        spl.minHi = true;
      }
      return ec;
    }
  }
}

/** xdl_recs_cmp: divide and conquer over the compared records */
function recsCmp(
  dd1: DiffData,
  off1: number,
  lim1: number,
  dd2: DiffData,
  off2: number,
  lim2: number,
  kvdf: Float64Array,
  kvdb: Float64Array,
  base: number,
  needMin: boolean,
  xenv: AlgoEnv,
): void {
  const ha1 = dd1.ha;
  const ha2 = dd2.ha;
  for (; off1 < lim1 && off2 < lim2 && ha1[off1] === ha2[off2]; off1++, off2++);
  for (; off1 < lim1 && off2 < lim2 && ha1[lim1 - 1] === ha2[lim2 - 1]; lim1--, lim2--);
  if (off1 === lim1) {
    for (; off2 < lim2; off2++) dd2.rchg[(dd2.rindex[off2] as number) + 1] = 1;
  } else if (off2 === lim2) {
    for (; off1 < lim1; off1++) dd1.rchg[(dd1.rindex[off1] as number) + 1] = 1;
  } else {
    const spl: Split = { i1: 0, i2: 0, minLo: false, minHi: false };
    split(ha1, off1, lim1, ha2, off2, lim2, kvdf, kvdb, base, needMin, spl, xenv);
    recsCmp(dd1, off1, spl.i1, dd2, off2, spl.i2, kvdf, kvdb, base, spl.minLo, xenv);
    recsCmp(dd1, spl.i1, lim1, dd2, spl.i2, lim2, kvdf, kvdb, base, spl.minHi, xenv);
  }
}

/** xdl_do_diff with the classic algorithm */
function classicDiff(a: Uint8Array, b: Uint8Array): XdEnv {
  const cf: Classifier = { classes: new Map(), len1: [], len2: [] };
  const xdf1 = prepareCtx(1, a, cf);
  const xdf2 = prepareCtx(2, b, cf);
  const [dd1, dd2] = optimize(cf, xdf1, xdf2);
  const ndiags = dd1.nrec + dd2.nrec + 3;
  const kvdf = new Float64Array(2 * ndiags + 2);
  const kvdb = new Float64Array(2 * ndiags + 2);
  const base = dd2.nrec + 1;
  let mxcost = xdlBogosqrt(ndiags);
  if (mxcost < XDL_MAX_COST_MIN) mxcost = XDL_MAX_COST_MIN;
  const xenv: AlgoEnv = { mxcost, snakeCnt: XDL_SNAKE_CNT, heurMin: XDL_HEUR_MIN_COST };
  recsCmp(dd1, 0, dd1.nrec, dd2, 0, dd2.nrec, kvdf, kvdb, base, false, xenv);
  return { xdf1, xdf2 };
}

// ---- histogram (xhistogram.c) ----

interface HistRecord {
  ptr: number;
  cnt: number;
  next: HistRecord | undefined;
}
interface Region {
  begin1: number;
  end1: number;
  begin2: number;
  end2: number;
}
const MAX_CNT = 0xffffffff;

/** xdl_fall_back_diff: the classic algorithm on whole-line sub-ranges, copied back */
function fallBack(env: XdEnv, line1: number, count1: number, line2: number, count2: number) {
  const x1 = env.xdf1;
  const x2 = env.xdf2;
  const a = x1.data.subarray(x1.start[line1 - 1], x1.end[line1 + count1 - 2]);
  const b = x2.data.subarray(x2.start[line2 - 1], x2.end[line2 + count2 - 2]);
  const sub = classicDiff(a, b);
  x1.rchg.set(sub.xdf1.rchg.subarray(1, 1 + count1), line1);
  x2.rchg.set(sub.xdf2.rchg.subarray(1, 1 + count2), line2);
}

/** find_lcs: 1 → fall back to classic, 0 → `lcs` found (or none) */
function findLcs(
  env: XdEnv,
  lcs: Region,
  line1: number,
  count1: number,
  line2: number,
  count2: number,
): number {
  const ha1 = env.xdf1.ha;
  const ha2 = env.xdf2.ha;
  const end1 = line1 + count1 - 1;
  const end2 = line2 + count2 - 1;
  const tableBits = xdlHashbits(count1);
  const records: (HistRecord | undefined)[] = new Array(1 << tableBits);
  const lineMap: (HistRecord | undefined)[] = new Array(count1);
  const nextPtrs = new Array<number>(count1).fill(0);
  const ptrShift = line1;
  const maxChainLength = 64;
  const h1 = (l: number) => ha1[l - 1] as number;
  const h2 = (l: number) => ha2[l - 1] as number;
  // scanA
  for (let ptr = end1; line1 <= ptr; ptr--) {
    const tbl = hashlong(h1(ptr), tableBits);
    let rec = records[tbl];
    let chainLen = 0;
    let found = false;
    while (rec) {
      if (h1(rec.ptr) === h1(ptr)) {
        nextPtrs[ptr - ptrShift] = rec.ptr;
        rec.ptr = ptr;
        rec.cnt = Math.min(MAX_CNT, rec.cnt + 1);
        lineMap[ptr - ptrShift] = rec;
        found = true;
        break;
      }
      rec = rec.next;
      chainLen++;
    }
    if (found) continue;
    if (chainLen === maxChainLength) return -1;
    const fresh: HistRecord = { ptr, cnt: 1, next: records[tbl] };
    records[tbl] = fresh;
    lineMap[ptr - ptrShift] = fresh;
  }
  let cnt = maxChainLength + 1;
  let hasCommon = false;
  const CNT = (p: number) => (lineMap[p - ptrShift] as HistRecord).cnt;
  for (let bPtr = line2; bPtr <= end2; ) {
    // try_lcs
    let bNext = bPtr + 1;
    for (let rec = records[hashlong(h2(bPtr), tableBits)]; rec; rec = rec.next) {
      if (rec.cnt > cnt) {
        if (!hasCommon) hasCommon = h1(rec.ptr) === h2(bPtr);
        continue;
      }
      let as = rec.ptr;
      if (h1(as) !== h2(bPtr)) continue;
      hasCommon = true;
      for (;;) {
        let np = nextPtrs[as - ptrShift] as number;
        let bs = bPtr;
        let ae = as;
        let be = bs;
        let rc = rec.cnt;
        while (line1 < as && line2 < bs && h1(as - 1) === h2(bs - 1)) {
          as--;
          bs--;
          if (1 < rc) rc = Math.min(rc, CNT(as));
        }
        while (ae < end1 && be < end2 && h1(ae + 1) === h2(be + 1)) {
          ae++;
          be++;
          if (1 < rc) rc = Math.min(rc, CNT(ae));
        }
        if (bNext <= be) bNext = be + 1;
        if (lcs.end1 - lcs.begin1 < ae - as || rc < cnt) {
          lcs.begin1 = as;
          lcs.begin2 = bs;
          lcs.end1 = ae;
          lcs.end2 = be;
          cnt = rc;
        }
        if (np === 0) break;
        let shouldBreak = false;
        while (np <= ae) {
          np = nextPtrs[np - ptrShift] as number;
          if (np === 0) {
            shouldBreak = true;
            break;
          }
        }
        if (shouldBreak) break;
        as = np;
      }
    }
    bPtr = bNext;
  }
  return hasCommon && maxChainLength < cnt ? 1 : 0;
}

function histogramDiff(env: XdEnv, line1: number, count1: number, line2: number, count2: number) {
  const r1 = env.xdf1.rchg;
  const r2 = env.xdf2.rchg;
  for (;;) {
    if (count1 <= 0 && count2 <= 0) return;
    if (!count1) {
      while (count2--) r2[line2++] = 1;
      return;
    }
    if (!count2) {
      while (count1--) r1[line1++] = 1;
      return;
    }
    const lcs: Region = { begin1: 0, end1: 0, begin2: 0, end2: 0 };
    const found = findLcs(env, lcs, line1, count1, line2, count2);
    if (found < 0)
      throw new XdiffLimitError("xdiff: histogram chain too long (git fails this merge too)");
    if (found) {
      fallBack(env, line1, count1, line2, count2);
      return;
    }
    if (lcs.begin1 === 0 && lcs.begin2 === 0) {
      while (count1--) r1[line1++] = 1;
      while (count2--) r2[line2++] = 1;
      return;
    }
    histogramDiff(env, line1, lcs.begin1 - line1, line2, lcs.begin2 - line2);
    const end1 = line1 + count1 - 1;
    const end2 = line2 + count2 - 1;
    count1 = end1 - lcs.end1;
    line1 = lcs.end1 + 1;
    count2 = end2 - lcs.end2;
    line2 = lcs.end2 + 1;
  }
}

/** xdl_do_diff with merge-ort's algorithm (histogram) */
export function xdlDoDiff(a: Uint8Array, b: Uint8Array): XdEnv {
  const cf: Classifier = { classes: new Map(), len1: [], len2: [] };
  const xdf1 = prepareCtx(1, a, cf);
  const xdf2 = prepareCtx(2, b, cf);
  const env = { xdf1, xdf2 };
  // histogram lines are 1-based: rchg[line] is the C's rchg[line - 1]
  histogramDiff(
    env,
    xdf1.dstart + 1,
    xdf1.dend - xdf1.dstart + 1,
    xdf2.dstart + 1,
    xdf2.dend - xdf2.dstart + 1,
  );
  return env;
}

// ---- xdl_change_compact, xdl_build_script (xdiffi.c) ----

interface Group {
  start: number;
  end: number;
}
const chg = (x: XdFile, i: number) => x.rchg[i + 1] as number;
const setChg = (x: XdFile, i: number, v: number) => {
  x.rchg[i + 1] = v;
};
function groupInit(x: XdFile, g: Group) {
  g.start = g.end = 0;
  while (chg(x, g.end)) g.end++;
}
function groupNext(x: XdFile, g: Group): boolean {
  if (g.end === x.nrec) return false;
  g.start = g.end + 1;
  for (g.end = g.start; chg(x, g.end); g.end++);
  return true;
}
function groupPrevious(x: XdFile, g: Group): boolean {
  if (g.start === 0) return false;
  g.end = g.start - 1;
  for (g.start = g.end; chg(x, g.start - 1); g.start--);
  return true;
}
function groupSlideDown(x: XdFile, g: Group): boolean {
  if (g.end < x.nrec && x.ha[g.start] === x.ha[g.end]) {
    setChg(x, g.start++, 0);
    setChg(x, g.end++, 1);
    while (chg(x, g.end)) g.end++;
    return true;
  }
  return false;
}
function groupSlideUp(x: XdFile, g: Group): boolean {
  if (g.start > 0 && x.ha[g.start - 1] === x.ha[g.end - 1]) {
    setChg(x, --g.start, 1);
    setChg(x, --g.end, 0);
    while (chg(x, g.start - 1)) g.start--;
    return true;
  }
  return false;
}

/** slides groups of changes as far down as they go, back up to align with the other side's */
export function xdlChangeCompact(x: XdFile, xo: XdFile): void {
  const g: Group = { start: 0, end: 0 };
  const go: Group = { start: 0, end: 0 };
  groupInit(x, g);
  groupInit(xo, go);
  for (;;) {
    if (g.end !== g.start) {
      let groupsize: number;
      let earliestEnd: number;
      let endMatchingOther: number;
      do {
        groupsize = g.end - g.start;
        endMatchingOther = -1;
        while (groupSlideUp(x, g))
          if (!groupPrevious(xo, go)) throw new Error("xdiff: group sync broken sliding up");
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        for (;;) {
          if (!groupSlideDown(x, g)) break;
          if (!groupNext(xo, go)) throw new Error("xdiff: group sync broken sliding down");
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupsize !== g.end - g.start);
      if (g.end === earliestEnd) {
        // no shifting was possible
      } else if (endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!groupSlideUp(x, g)) throw new Error("xdiff: match disappeared");
          if (!groupPrevious(xo, go)) throw new Error("xdiff: group sync broken sliding to match");
        }
      }
      // (no indent heuristic: merge-ort does not set it)
    }
    if (!groupNext(x, g)) break;
    if (!groupNext(xo, go)) throw new Error("xdiff: group sync broken moving to next group");
  }
  if (groupNext(xo, go)) throw new Error("xdiff: group sync broken at end of file");
}

/** the changes, in order */
export function xdlBuildScript(env: XdEnv): XdChange[] {
  const out: XdChange[] = [];
  const x1 = env.xdf1;
  const x2 = env.xdf2;
  for (let i1 = x1.nrec, i2 = x2.nrec; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (chg(x1, i1 - 1) || chg(x2, i2 - 1)) {
      const l1 = i1;
      for (; chg(x1, i1 - 1); i1--);
      const l2 = i2;
      for (; chg(x2, i2 - 1); i2--);
      out.push({ i1, i2, chg1: l1 - i1, chg2: l2 - i2 });
    }
  }
  return out.reverse();
}

/** diff, compact both ways, script: what xdl_merge does to each side */
export function xdlDiffScript(a: Uint8Array, b: Uint8Array): { env: XdEnv; script: XdChange[] } {
  const env = xdlDoDiff(a, b);
  xdlChangeCompact(env.xdf1, env.xdf2);
  xdlChangeCompact(env.xdf2, env.xdf1);
  return { env, script: xdlBuildScript(env) };
}
