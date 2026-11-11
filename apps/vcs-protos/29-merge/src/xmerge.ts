/**
 * X13a — git's three-way content merge (xmerge.c, v2.43.0) at merge-ort's settings: level
 * ZEALOUS (overlapping changes that are identical are not conflicts; a conflict is refined by
 * diffing the two sides, and conflicts at most three lines apart are joined), the "merge" style
 * (no base section), 7-character markers labelled with the given names, CRLF markers when the
 * surrounding lines use CRLF. Binary inputs (a NUL in the first 8000 bytes: merge-ll.c) are not
 * merged: ours is kept and it is a conflict, as `git merge-tree` does.
 */
import {
  type XdChange,
  type XdEnv,
  type XdFile,
  type XdOptions,
  xdlBuildScript,
  xdlChangeCompact,
  xdlDiffScript,
  xdlDoDiff,
} from "./xdiff.js";

export interface ContentMergeResult {
  content: Uint8Array;
  /** conflict hunks (0: clean) */
  conflicts: number;
  binary: boolean;
}
export interface ContentMergeLabels {
  ours: string;
  theirs: string;
  base?: string;
  /** conflict marker length (7; merge-ort adds 1 for rename/rename and rename collisions) */
  markerSize?: number;
  /** an inner merge of merge bases (`virtual_ancestor`): binary files keep the base, cleanly */
  virtualAncestor?: boolean;
  /**
   * the caller already took merge-ort's oid shortcuts (handle_content_merge), so this is
   * ll_xdl_merge: binary is checked first. Matters for two-way merges, whose base is empty
   */
  afterOidShortcuts?: boolean;
}

const MARKER_SIZE = 7;
/** git's MAX_XDIFF_SIZE (xdiff-interface.h): larger inputs are merged as binary */
export const MAX_XDIFF_SIZE = 1024 * 1024 * 1023;
const FIRST_FEW_BYTES = 8000;

export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, FIRST_FEW_BYTES).indexOf(0) >= 0;
}

/** a hunk of the merge (exported for tests) */
export interface Merge {
  /** 0 conflict, 1 take side 1, 2 take side 2, 3 both, 4 identical after refinement */
  mode: number;
  i0: number;
  chg0: number;
  i1: number;
  chg1: number;
  i2: number;
  chg2: number;
}

function appendMerge(
  list: Merge[],
  mode: number,
  i0: number,
  chg0: number,
  i1: number,
  chg1: number,
  i2: number,
  chg2: number,
) {
  const m = list.at(-1);
  if (m && (i1 <= m.i1 + m.chg1 || i2 <= m.i2 + m.chg2)) {
    if (mode !== m.mode) m.mode = 0;
    m.chg0 = i0 + chg0 - m.i0;
    m.chg1 = i1 + chg1 - m.i1;
    m.chg2 = i2 + chg2 - m.i2;
  } else list.push({ mode, i0, chg0, i1, chg1, i2, chg2 });
}

const recBytes = (x: XdFile, i: number) => x.data.subarray(x.start[i], x.end[i]);
function recEqual(a: XdFile, i: number, b: XdFile, j: number): boolean {
  const s1 = (a.end[i] as number) - (a.start[i] as number);
  if (s1 !== (b.end[j] as number) - (b.start[j] as number)) return false;
  const p = a.start[i] as number;
  const q = b.start[j] as number;
  for (let k = 0; k < s1; k++) if (a.data[p + k] !== b.data[q + k]) return false;
  return true;
}

/** xdl_merge_cmp_lines: the postimage lines of both sides equal */
function cmpLines(xe1: XdEnv, i1: number, xe2: XdEnv, i2: number, count: number): boolean {
  for (let i = 0; i < count; i++) if (!recEqual(xe1.xdf2, i1 + i, xe2.xdf2, i2 + i)) return false;
  return true;
}

/** is_eol_crlf: 1 CRLF, 0 LF, -1 undetermined */
function isEolCrlf(x: XdFile, i: number): number {
  const size = (k: number) => (x.end[k] as number) - (x.start[k] as number);
  const at = (k: number, back: number) => x.data[(x.end[k] as number) - back];
  if (i < x.nrec - 1) return size(i) > 1 && at(i, 2) === 13 ? 1 : 0;
  if (!x.nrec) return -1;
  if (size(i) && at(i, 1) === 10) return size(i) > 1 && at(i, 2) === 13 ? 1 : 0;
  if (!i) return -1;
  return size(i - 1) > 1 && at(i - 1, 2) === 13 ? 1 : 0;
}
function isCrNeeded(xe1: XdEnv, xe2: XdEnv, m: Merge): boolean {
  let needs = isEolCrlf(xe1.xdf2, m.i1 ? m.i1 - 1 : 0);
  if (needs) needs = isEolCrlf(xe2.xdf2, m.i2 ? m.i2 - 1 : 0);
  if (needs) needs = isEolCrlf(xe1.xdf1, 0);
  return needs < 0 ? false : needs === 1;
}

/** the merge output, growing */
class Out {
  private parts: Uint8Array[] = [];
  size = 0;
  push(b: Uint8Array) {
    if (!b.length) return;
    this.parts.push(b);
    this.size += b.length;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}
const enc = new TextEncoder();

/** xdl_recs_copy_0: `count` records from `i`, with a newline added after the last if asked */
function recsCopy(out: Out, x: XdFile, i: number, count: number, needsCr: boolean, addNl: boolean) {
  if (count < 1) return;
  out.push(x.data.subarray(x.start[i], x.end[i + count - 1]));
  if (addNl) {
    const last = recBytes(x, i + count - 1);
    if (last.length === 0 || last[last.length - 1] !== 10)
      out.push(needsCr ? enc.encode("\r\n") : enc.encode("\n"));
  }
}

function marker(
  ch: string,
  name: string | undefined,
  needsCr: boolean,
  size = MARKER_SIZE,
): Uint8Array {
  return enc.encode(
    `${ch.repeat(size)}${name !== undefined ? ` ${name}` : ""}${needsCr ? "\r" : ""}\n`,
  );
}

function fillMergeBuffer(
  xe1: XdEnv,
  xe2: XdEnv,
  merges: Merge[],
  labels: ContentMergeLabels,
): Uint8Array {
  const out = new Out();
  let i = 0;
  for (const m of merges) {
    if (m.mode === 0) {
      const needsCr = isCrNeeded(xe1, xe2, m);
      recsCopy(out, xe1.xdf2, i, m.i1 - i, false, false);
      out.push(marker("<", labels.ours, needsCr, labels.markerSize));
      recsCopy(out, xe1.xdf2, m.i1, m.chg1, needsCr, true);
      out.push(marker("=", undefined, needsCr, labels.markerSize));
      recsCopy(out, xe2.xdf2, m.i2, m.chg2, needsCr, true);
      out.push(marker(">", labels.theirs, needsCr, labels.markerSize));
    } else if (m.mode & 3) {
      recsCopy(out, xe1.xdf2, i, m.i1 - i, false, false);
      if (m.mode & 1)
        recsCopy(out, xe1.xdf2, m.i1, m.chg1, isCrNeeded(xe1, xe2, m), (m.mode & 2) !== 0);
      if (m.mode & 2) recsCopy(out, xe2.xdf2, m.i2, m.chg2, false, false);
    } else continue;
    i = m.i1 + m.chg1;
  }
  recsCopy(out, xe1.xdf2, i, xe1.xdf2.nrec - i, false, false);
  return out.bytes();
}

/** xdl_refine_conflicts: a conflict narrowed to where the two sides differ */
function refineConflicts(xe1: XdEnv, xe2: XdEnv, merges: Merge[], opts: XdOptions): Merge[] {
  const out: Merge[] = [];
  for (const m of merges) {
    if (m.mode || m.chg1 === 0 || m.chg2 === 0) {
      out.push(m);
      continue;
    }
    const a1 = xe1.xdf2;
    const a2 = xe2.xdf2;
    const t1 = a1.data.subarray(a1.start[m.i1], a1.end[m.i1 + m.chg1 - 1]);
    const t2 = a2.data.subarray(a2.start[m.i2], a2.end[m.i2 + m.chg2 - 1]);
    const env = xdlDoDiff(t1, t2);
    xdlChangeCompact(env.xdf1, env.xdf2, opts);
    xdlChangeCompact(env.xdf2, env.xdf1, opts);
    const script = xdlBuildScript(env);
    if (!script.length) {
      m.mode = 4; // identical
      out.push(m);
      continue;
    }
    const i1 = m.i1;
    const i2 = m.i2;
    for (const [k, x] of script.entries()) {
      // the first keeps the conflict's base range (unused in this style), as the C
      out.push(
        k === 0
          ? { ...m, i1: x.i1 + i1, chg1: x.chg1, i2: x.i2 + i2, chg2: x.chg2 }
          : {
              mode: 0,
              i0: m.i0,
              chg0: m.chg0,
              i1: x.i1 + i1,
              chg1: x.chg1,
              i2: x.i2 + i2,
              chg2: x.chg2,
            },
      );
    }
  }
  return out;
}

/**
 * xdl_simplify_non_conflicts: conflicts at most 3 lines apart are joined. One pass, as git's
 * list walk: a grown conflict is compared with its new next.
 */
export function simplifyNonConflicts(merges: Merge[]): Merge[] {
  const out: Merge[] = [];
  for (const next of merges) {
    const m = out.at(-1);
    if (m && m.mode === 0 && next.mode === 0 && next.i1 - (m.i1 + m.chg1) <= 3) {
      m.chg1 = next.i1 + next.chg1 - m.i1;
      m.chg2 = next.i2 + next.chg2 - m.i2;
    } else out.push(next);
  }
  return out;
}

function doMerge(
  xe1: XdEnv,
  s1: XdChange[],
  xe2: XdEnv,
  s2: XdChange[],
  labels: ContentMergeLabels,
  opts: XdOptions,
) {
  const merges: Merge[] = [];
  let a = 0;
  let b = 0;
  while (a < s1.length && b < s2.length) {
    const x1 = s1[a] as XdChange;
    const x2 = s2[b] as XdChange;
    if (x1.i1 + x1.chg1 < x2.i1) {
      appendMerge(merges, 1, x1.i1, x1.chg1, x1.i2, x1.chg2, x2.i2 - x2.i1 + x1.i1, x1.chg1);
      a++;
      continue;
    }
    if (x2.i1 + x2.chg1 < x1.i1) {
      appendMerge(merges, 2, x2.i1, x2.chg1, x1.i2 - x1.i1 + x2.i1, x2.chg1, x2.i2, x2.chg2);
      b++;
      continue;
    }
    if (
      x1.i1 !== x2.i1 ||
      x1.chg1 !== x2.chg1 ||
      x1.chg2 !== x2.chg2 ||
      !cmpLines(xe1, x1.i2, xe2, x2.i2, x1.chg2)
    ) {
      const off = x1.i1 - x2.i1;
      const ffo = off + x1.chg1 - x2.chg1;
      let i0 = x1.i1;
      let i1 = x1.i2;
      let i2 = x2.i2;
      if (off > 0) {
        i0 -= off;
        i1 -= off;
      } else i2 += off;
      let chg0 = x1.i1 + x1.chg1 - i0;
      let chg1 = x1.i2 + x1.chg2 - i1;
      let chg2 = x2.i2 + x2.chg2 - i2;
      if (ffo < 0) {
        chg0 -= ffo;
        chg1 -= ffo;
      } else chg2 += ffo;
      appendMerge(merges, 0, i0, chg0, i1, chg1, i2, chg2);
    }
    const e1 = x1.i1 + x1.chg1;
    const e2 = x2.i1 + x2.chg1;
    if (e1 >= e2) b++;
    if (e2 >= e1) a++;
  }
  for (; a < s1.length; a++) {
    const x1 = s1[a] as XdChange;
    appendMerge(
      merges,
      1,
      x1.i1,
      x1.chg1,
      x1.i2,
      x1.chg2,
      x1.i1 + xe2.xdf2.nrec - xe2.xdf1.nrec,
      x1.chg1,
    );
  }
  for (; b < s2.length; b++) {
    const x2 = s2[b] as XdChange;
    appendMerge(
      merges,
      2,
      x2.i1,
      x2.chg1,
      x2.i1 + xe1.xdf2.nrec - xe1.xdf1.nrec,
      x2.chg1,
      x2.i2,
      x2.chg2,
    );
  }
  const refined = simplifyNonConflicts(refineConflicts(xe1, xe2, merges, opts));
  const content = fillMergeBuffer(xe1, xe2, refined, labels);
  return { content, conflicts: refined.filter((m) => m.mode === 0).length };
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** git's content merge of `ours` and `theirs` against `base` */
export function mergeContent(
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
  labels: ContentMergeLabels,
  opts: XdOptions = {},
): ContentMergeResult {
  // merge-ort's trivial merges (handle_content_merge), before anything looks at the bytes
  if (!labels.afterOidShortcuts) {
    if (same(ours, theirs) || same(ours, base))
      return { content: theirs, conflicts: 0, binary: false };
    if (same(theirs, base)) return { content: ours, conflicts: 0, binary: false };
  }
  const tooLarge = [base, ours, theirs].some((b) => b.length > MAX_XDIFF_SIZE);
  if (tooLarge || isBinary(base) || isBinary(ours) || isBinary(theirs))
    return labels.virtualAncestor
      ? { content: base, conflicts: 0, binary: false }
      : { content: ours, conflicts: 1, binary: true };
  const { env: xe1, script: s1 } = xdlDiffScript(base, ours, opts);
  const { env: xe2, script: s2 } = xdlDiffScript(base, theirs, opts);
  if (!s1.length) return { content: theirs, conflicts: 0, binary: false };
  if (!s2.length) return { content: ours, conflicts: 0, binary: false };
  return { ...doMerge(xe1, s1, xe2, s2, labels, opts), binary: false };
}
