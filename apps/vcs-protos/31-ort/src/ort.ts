/**
 * X13d — merge-ort ported along its own structure (merge-ort.c, git v2.43.0), with renames and
 * without directory renames:
 * - `collect_merge_info`: a walk of the three trees, one entry per path (resolved early when it
 *   can be), rename sources and destinations collected, directories one side left alone deferred
 *   and then resolved whole (`handle_deferred_entries`), and the redo after renames;
 * - `detect_and_process_renames`: X13c's rename detection over ort's relevant sources, then
 *   `process_renames`;
 * - `process_entries`: paths bottom-up, directories written once their contents are done,
 *   `process_entry` for every conflicted path.
 */

import { readTree } from "../../17-repository/src/commands.js";
import type { TreeEntry } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import {
  type ConflictEntry,
  comparePaths,
  type MergeMessage,
  type TreeMergeOptions,
  type TreeMergeResult,
} from "../../29-merge/src/merge-trees.js";
import { mergeContent } from "../../29-merge/src/xmerge.js";
import { GitStrMap } from "../../30-renames/src/git-strmap.js";
import { findRenames } from "../../30-renames/src/renames.js";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFGITLINK = 0o160000;
const NULL_OID = "0".repeat(40);

interface Version {
  /** 0 for none */
  mode: number;
  oid: string;
}
const none = (): Version => ({ mode: 0, oid: NULL_OID });
const sameVersion = (a: Version, b: Version) => a.mode === b.mode && a.oid === b.oid;
const isReg = (mode: number) => (mode & S_IFMT) === S_IFREG;

/** merged_info: what a path resolved to */
interface Merged {
  result: Version;
  isNull: boolean;
  clean: boolean;
}
/** conflict_info */
interface Conflict extends Merged {
  conflict: true;
  stages: [Version, Version, Version];
  pathnames: [string, string, string];
  filemask: number;
  dirmask: number;
  matchMask: number;
  dfConflict: boolean;
  pathConflict: boolean;
}
type Info = Merged | Conflict;

/** a diff_filepair of ort's rename detection */
interface FilePair {
  status: "A" | "D" | "R";
  one?: { path: string; v: Version };
  two?: { path: string; v: Version };
  /** the side it came from (process_renames' `score`) */
  side?: 1 | 2;
}
const onePath = (p: FilePair) => (p.one?.path ?? p.two?.path) as string;
const twoPath = (p: FilePair) => (p.two?.path ?? p.one?.path) as string;

/** `canon_mode` */
function canonMode(mode: number): number {
  switch (mode & S_IFMT) {
    case S_IFREG:
      return mode & 0o100 ? 0o100755 : 0o100644;
    case S_IFDIR:
      return S_IFDIR;
    case S_IFLNK:
      return S_IFLNK;
    default:
      return S_IFGITLINK;
  }
}

/** `sort_dirs_next_to_their_children`: as if every path ended in "/" */
const utf8 = new TextEncoder();
function sortDirsNextToChildren(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  const c1 = i < x.length ? (x[i] as number) : 0x2f;
  const c2 = i < y.length ? (y[i] as number) : 0x2f;
  if (c1 === c2) return i < x.length ? 1 : -1;
  return c1 - c2;
}

const fnvEnc = new TextEncoder();

/** `name_compare`: bytes, then length */
function nameCompare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}
/** `check_entry_match`: 0 found, 1 keep looking (`a` may hide behind `b`), -1 absent */
function checkEntryMatch(a: Uint8Array, b: Uint8Array): number {
  const cmp = nameCompare(a, b);
  if (!cmp) return 0;
  if (cmp > 0) return 1;
  if (a.length < b.length && a.every((c, i) => b[i] === c) && (b[a.length] as number) < 0x2f)
    return 1;
  return -1;
}
/**
 * The names `traverse_trees` visits, in its order: the smallest head by `name_compare`, found in
 * each tree at its head or just behind it (a directory `t` hides behind `t-2`), entries taken early
 * skipped later.
 */
function traverseOrder(levels: Map<string, unknown>[]): string[] {
  const lists = levels.map((l) => [...l.keys()].map((k) => ({ k, b: fnvEnc.encode(k) })));
  const cursors = lists.map(() => ({ d: 0, skip: new Set<number>() }));
  const out: string[] = [];
  for (;;) {
    const heads = cursors.map((t, i) => {
      const list = lists[i] as { k: string; b: Uint8Array }[];
      while (t.d < list.length && t.skip.has(t.d)) t.d++;
      return t.d < list.length ? t.d : -1;
    });
    let first: { k: string; b: Uint8Array } | undefined;
    heads.forEach((h, i) => {
      if (h < 0) return;
      const e = (lists[i] as { k: string; b: Uint8Array }[])[h] as { k: string; b: Uint8Array };
      if (!first || nameCompare(e.b, first.b) < 0) first = e;
    });
    if (!first) return out;
    const name = first;
    out.push(name.k);
    heads.forEach((h, i) => {
      if (h < 0) return;
      const list = lists[i] as { k: string; b: Uint8Array }[];
      const t = cursors[i] as { d: number; skip: Set<number> };
      let j = -1;
      const m = checkEntryMatch(name.b, (list[h] as { b: Uint8Array }).b);
      if (m === 0) j = h;
      else if (m === 1)
        for (let p = t.d; p < list.length; p++) {
          const mm = checkEntryMatch(name.b, (list[p] as { b: Uint8Array }).b);
          if (mm === -1) break;
          if (mm === 0) {
            j = p;
            break;
          }
        }
      if (j < 0) return;
      if (t.d === j) t.d++;
      else t.skip.add(j);
    });
  }
}

/**
 * write_tree as merge-ort does it: entries in tree order (a directory sorts as "name/"), each mode
 * as `%o`. Unlike a checked tree writer it writes what the merge produced, git's mode-0 entries
 * included (a file split from a base directory by a directory rename, merge-ort.c's
 * apply_directory_rename_modifications zeroing stage 1)
 */
async function writeRawTree(repo: Repository, entries: TreeEntry[]): Promise<string> {
  const key = (e: TreeEntry) => {
    const b = fnvEnc.encode(e.name);
    if (Number.parseInt(e.mode, 8) !== S_IFDIR) return b;
    const k = new Uint8Array(b.length + 1);
    k.set(b);
    k[b.length] = 0x2f;
    return k;
  };
  const sorted = [...entries].sort((x, y) => nameCompare(key(x), key(y)));
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    parts.push(fnvEnc.encode(`${Number.parseInt(e.mode, 8).toString(8)} ${e.name}\0`));
    const oid = new Uint8Array(20);
    for (let i = 0; i < 20; i++) oid[i] = Number.parseInt(e.oid.slice(2 * i, 2 * i + 2), 16);
    parts.push(oid);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return repo.objects.put("tree", out);
}

const dirOf = (path: string) => {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
};
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

class OrtMerge {
  paths = new Map<string, Info>();
  conflicted = new Map<string, Conflict>();
  messages = new Map<string, MergeMessage[]>();
  // rename_info, per side (index 1 and 2)
  pairs: FilePair[][] = [[], [], []];
  /** relevant_sources: path → RELEVANT_CONTENT (1), RELEVANT_LOCATION (2), RELEVANT_NO_MORE (0) */
  relevant: Map<string, number>[] = [new Map(), new Map(), new Map()];
  cachedIrrelevant: Set<string>[] = [new Set(), new Set(), new Set()];
  /** dirs_removed: directory → NOT_RELEVANT (0), RELEVANT_FOR_ANCESTOR (1), RELEVANT_FOR_SELF (2) */
  dirsRemoved: Map<string, number>[] = [new Map(), new Map(), new Map()];
  dirRenameCount: Map<string, GitStrMap<number>>[] = [new Map(), new Map(), new Map()];
  /** dir_renames: old directory → new directory, per side */
  dirRenames: Map<string, string>[] = [new Map(), new Map(), new Map()];
  dirRenameClean = true;
  cachedPairs: Map<string, string | null>[] = [new Map(), new Map(), new Map()];
  cachedTargetNames: Set<string>[] = [new Set(), new Set(), new Set()];
  deferred: GitStrMap<number>[] = [new GitStrMap(), new GitStrMap(), new GitStrMap()];
  trivialOkay = [true, true, true];
  targetDirs: Set<string>[] = [new Set(), new Set(), new Set()];
  dirRenameMask = 0;
  /** redo_after_renames: 0, 1 (wanted), 2 (restart with cached renames) */
  redo = 0;
  trees = new Map<string, Map<string, Version>>();

  constructor(
    readonly repo: Repository,
    readonly opts: TreeMergeOptions,
    /** call_depth: 0 for the merge itself, deeper for merges of merge bases */
    readonly depth = 0,
  ) {}

  reset() {
    this.paths = new Map();
    this.conflicted = new Map();
    this.messages = new Map();
    this.pairs = [[], [], []];
    this.relevant = [new Map(), new Map(), new Map()];
    this.dirsRemoved = [new Map(), new Map(), new Map()];
    this.dirRenames = [new Map(), new Map(), new Map()];
    this.deferred = [new GitStrMap(), new GitStrMap(), new GitStrMap()];
    this.trivialOkay = [true, true, true];
    this.targetDirs = [new Set(), new Set(), new Set()];
    this.dirRenameMask = 0;
  }

  async entries(oid: string | undefined): Promise<Map<string, Version>> {
    if (!oid) return new Map();
    const known = this.trees.get(oid);
    if (known) return known;
    const m = new Map<string, Version>();
    for (const e of (await readTree(this.repo, oid)) as TreeEntry[])
      m.set(e.name, { mode: canonMode(Number.parseInt(e.mode, 8)), oid: e.oid });
    this.trees.set(oid, m);
    return m;
  }

  pathMsg(primary: string, others: string[], text: string) {
    if (this.depth) return; // inner merges report nothing
    const list = this.messages.get(primary) ?? [];
    this.messages.set(primary, list);
    list.push({ paths: [primary, ...others], text: `${text}\n` });
  }

  // ─── collect_merge_info ───────────────────────────────────────────────────────────────

  /** traverse_trees over one directory of the three trees (the wrapper when dir_rename_mask asks) */
  async traverse(dir: string, trees: (string | undefined)[]) {
    const levels = await Promise.all(trees.map((t) => this.entries(t)));
    const names = traverseOrder(levels);
    const rows = names.map((name) => levels.map((l) => l.get(name)));
    if (this.dirRenameMask !== 0 && this.dirRenameMask !== 7) {
      // traverse_trees_wrapper_callback: a file added on the side that kept the directory
      for (const row of rows) {
        const filemask = row.reduce(
          (m, e, i) => m | (e && (e.mode & S_IFMT) !== S_IFDIR ? 1 << i : 0),
          0,
        );
        if (filemask && filemask === this.dirRenameMask) this.dirRenameMask = 7;
      }
    }
    for (const [k, name] of names.entries())
      await this.callback(dir, name, rows[k] as (Version | undefined)[]);
  }

  async callback(dir: string, name: string, row: (Version | undefined)[]) {
    const names = row.map((e) => e ?? none());
    const isDir = (i: number) => !!row[i] && ((row[i] as Version).mode & S_IFMT) === S_IFDIR;
    let mask = 0;
    let dirmask = 0;
    for (let i = 0; i < 3; i++) {
      if (row[i]) mask |= 1 << i;
      if (isDir(i)) dirmask |= 1 << i;
    }
    const filemask = mask & ~dirmask;
    const prevDirRenameMask = this.dirRenameMask;
    const mbaseNull = !(mask & 1);
    const n0 = names[0] as Version;
    const n1 = names[1] as Version;
    const n2 = names[2] as Version;
    const side1MatchesBase = !!(mask & 2) && !mbaseNull && sameVersion(n0, n1);
    const side2MatchesBase = !!(mask & 4) && !mbaseNull && sameVersion(n0, n2);
    const sidesMatch = !!(mask & 2) && !!(mask & 4) && sameVersion(n1, n2);
    const dfConflict = filemask !== 0 && dirmask !== 0;
    let matchMask = 0;
    if (side1MatchesBase) matchMask = side2MatchesBase ? 7 : 3;
    else if (side2MatchesBase) matchMask = 5;
    else if (sidesMatch) matchMask = 6;
    const fullpath = dir ? `${dir}/${name}` : name;

    const resolved = (v: Version, isNull: boolean) =>
      this.paths.set(fullpath, { result: { ...v }, isNull, clean: true });
    if (side1MatchesBase && side2MatchesBase) return void resolved(n0, mbaseNull);
    if (sidesMatch && filemask === 7) return void resolved(n1, false);
    if (side1MatchesBase && filemask === 7) return void resolved(n2, false);
    if (side2MatchesBase && filemask === 7) return void resolved(n1, false);

    this.collectRenameInfo(names, fullpath, filemask, dirmask, matchMask);

    const ci: Conflict = {
      conflict: true,
      result: none(),
      isNull: dirmask !== 0,
      clean: false,
      stages: [{ ...n0 }, { ...n1 }, { ...n2 }],
      pathnames: [fullpath, fullpath, fullpath],
      filemask,
      dirmask,
      matchMask,
      dfConflict,
      pathConflict: false,
    };
    this.paths.set(fullpath, ci);

    if (dirmask) {
      let side = side1MatchesBase ? 2 : side2MatchesBase ? 1 : 0;
      if (filemask === 0 && (dirmask === 2 || dirmask === 4)) {
        // defer recursing into new directories too
        ci.matchMask = 7 - dirmask;
        side = dirmask / 2;
      }
      if (
        this.dirRenameMask !== 7 &&
        side !== 0 &&
        this.trivialOkay[side] &&
        !this.targetDirs[side]?.has(fullpath)
      ) {
        this.deferred[side]?.set(fullpath, this.dirRenameMask);
        this.dirRenameMask = prevDirRenameMask;
        return;
      }
      ci.matchMask &= filemask;
      await this.traverse(
        fullpath,
        [0, 1, 2].map((i) => (isDir(i) ? (row[i] as Version).oid : undefined)),
      );
      this.dirRenameMask = prevDirRenameMask;
    }
  }

  collectRenameInfo(
    names: Version[],
    fullpath: string,
    filemask: number,
    dirmask: number,
    matchMask: number,
  ) {
    if (this.dirRenameMask !== 7 && (dirmask === 3 || dirmask === 5))
      this.dirRenameMask = dirmask & ~1;
    // dirs_removed: a directory gone from a side; relevant for directory renames below it
    if (dirmask === 1 || dirmask === 3 || dirmask === 5) {
      const sides = (7 - dirmask) / 2;
      const relevance = this.dirRenameMask === 7 ? 1 : 0;
      if (sides & 1) this.dirsRemoved[1]?.set(fullpath, relevance);
      if (sides & 2) this.dirsRemoved[2]?.set(fullpath, relevance);
    }
    // a file added to a directory the other side removed: that directory's own rename matters
    if (this.dirRenameMask === 7 && (filemask === 2 || filemask === 4))
      this.dirsRemoved[3 - (filemask >> 1)]?.set(dirOf(fullpath), 2);
    if (filemask === 0 || filemask === 7) return;
    for (const side of [1, 2] as const) {
      const sideMask = 1 << side;
      if (filemask & 1 && !(filemask & sideMask))
        this.addPair(names, fullpath, side, false, matchMask & filemask);
      if (!(filemask & 1) && filemask & sideMask)
        this.addPair(names, fullpath, side, true, matchMask & filemask);
    }
  }

  addPair(names: Version[], path: string, side: 1 | 2, isAdd: boolean, matchMask: number) {
    if (isAdd) {
      if (this.cachedTargetNames[side]?.has(path)) return;
      this.pairs[side]?.push({ status: "A", two: { path, v: { ...(names[side] as Version) } } });
      return;
    }
    const contentRelevant = matchMask === 0;
    const locationRelevant = this.dirRenameMask === 7;
    if (contentRelevant || locationRelevant)
      this.relevant[side]?.set(path, contentRelevant ? 1 : 2);
    if (this.cachedPairs[side]?.has(path)) return;
    this.pairs[side]?.push({ status: "D", one: { path, v: { ...(names[0] as Version) } } });
  }

  async handleDeferredEntries() {
    const before = this.paths.size;
    let after = 0;
    for (const side of [1, 2] as const) {
      let okay = true;
      const cached = this.cachedPairs[side] as Map<string, string | null>;
      for (const src of (this.relevant[side] as Map<string, number>).keys()) {
        if (this.cachedIrrelevant[side]?.has(src)) continue;
        if (!cached.has(src)) {
          okay = false;
          break;
        }
        const target = cached.get(src);
        if (!target || this.paths.has(target)) continue;
        // the directories down to a rename target must be walked
        for (let d = dirOf(target); d; d = dirOf(d)) {
          if (this.targetDirs[side]?.has(d)) break;
          this.targetDirs[side]?.add(d);
        }
      }
      this.trivialOkay[side] = okay;
      const copy = this.deferred[side] as GitStrMap<number>;
      this.deferred[side] = new GitStrMap();
      for (const [path, mask] of copy.entries()) {
        const ci = this.paths.get(path) as Conflict;
        if (okay && !this.targetDirs[side]?.has(path)) {
          this.resolveTrivialDirectoryMerge(ci, side);
          continue;
        }
        // as merge-ort fills the descriptors: a side equal to another reuses its (maybe empty) tree
        const own = (i: number) => (ci.dirmask & (1 << i) ? ci.stages[i]?.oid : undefined);
        const t0 = own(0);
        const t1 = ci.matchMask === 3 ? t0 : own(1);
        const t2 = ci.matchMask === 5 ? t0 : ci.matchMask === 6 ? t1 : own(2);
        const trees = [t0, t1, t2];
        ci.matchMask &= ci.filemask;
        this.dirRenameMask = mask;
        await this.traverse(path, trees);
      }
      for (const path of (this.deferred[side] as GitStrMap<number>).keys())
        this.resolveTrivialDirectoryMerge(this.paths.get(path) as Conflict, side);
      if (!okay || after) after = this.paths.size;
    }
    if (after) {
      if (Math.floor(after / before) >= 3) this.redo = 1;
    } else if (this.redo === 2) this.redo = 0;
  }

  /**
   * resolve_trivial_directory_merge as newer git has it (2.56 checked): the matching sides leave
   * the masks, and a file left from a file/directory conflict stays unresolved (it may be part of a
   * rename). git 2.43 marks the entry clean, and then fails an assertion where this matters.
   */
  resolveTrivialDirectoryMerge(ci: Conflict, side: 1 | 2) {
    ci.result = { ...ci.stages[side] };
    ci.isNull = ci.stages[side].oid === NULL_OID;
    ci.dirmask &= ~ci.matchMask;
    ci.filemask &= ~ci.matchMask;
    ci.matchMask = 0;
    ci.clean = !ci.dfConflict || ci.dirmask !== 0;
    ci.dfConflict = false;
  }

  async collectMergeInfo(trees: (string | undefined)[]) {
    await this.traverse("", trees);
    await this.handleDeferredEntries();
  }

  // ─── renames ──────────────────────────────────────────────────────────────────────────

  possibleSideRenames(side: 1 | 2) {
    return (this.pairs[side]?.length ?? 0) > 0 && (this.relevant[side]?.size ?? 0) > 0;
  }

  async detectRegularRenames(side: 1 | 2): Promise<boolean> {
    const relevant = this.relevant[side] as Map<string, number>;
    for (const p of this.cachedPairs[side]?.keys() ?? []) relevant.delete(p);
    for (const p of this.cachedIrrelevant[side] ?? []) relevant.delete(p);
    // the counts survive the redo (cached_pairs_valid_side = -1): a pass that detects nothing keeps them
    if (!this.possibleSideRenames(side)) return false;
    this.dirRenameCount[side] = new Map();
    const pairs = this.pairs[side] as FilePair[];
    const found = await findRenames(
      this.repo,
      pairs.map((p) => ({
        path: onePath(p),
        old: p.status === "D" && p.one ? entryOf(p.one.v) : undefined,
        new: p.status === "A" && p.two ? entryOf(p.two.v) : undefined,
      })),
      {
        score: 50,
        limit: 7000,
        renameEmpty: false,
        relevant,
        dirsRemoved: this.dirsRemoved[side],
        dirRenameCount: this.dirRenameCount[side],
        legacyHashChars: this.opts.legacyHashChars,
      },
    );
    const used = new Set([...found.values()].map((r) => r.src));
    const out: FilePair[] = [];
    pairs.forEach((p, i) => {
      const r = found.get(i);
      if (r) out.push({ status: "R", one: (pairs[r.src] as FilePair).one, two: p.two });
      else if (!used.has(i)) out.push(p);
    });
    this.pairs[side] = out;
    return true;
  }

  possiblyCacheNewPair(p: FilePair, side: 1 | 2) {
    const val = this.relevant[side]?.get(onePath(p)) ?? -1;
    if (val === 0) this.cachedIrrelevant[side]?.add(onePath(p));
    if (val <= 0) return;
    if (p.status === "D") this.cachedPairs[side]?.set(onePath(p), null);
    else if (p.status === "R") {
      this.cachedPairs[side]?.set(onePath(p), twoPath(p));
      this.cachedTargetNames[side]?.add(twoPath(p));
    }
  }

  async detectAndProcessRenames(): Promise<boolean> {
    const possible =
      this.possibleSideRenames(1) ||
      this.possibleSideRenames(2) ||
      (this.cachedPairs[1]?.size ?? 0) > 0 ||
      (this.cachedPairs[2]?.size ?? 0) > 0;
    if (!possible) return true;
    if (this.opts.detectRenames === false) {
      this.redo = 0;
      return true;
    }
    let detectionRun = false;
    for (const side of [1, 2] as const)
      detectionRun = (await this.detectRegularRenames(side)) || detectionRun;
    if (this.redo && detectionRun) {
      for (const side of [1, 2] as const)
        for (const p of this.pairs[side] as FilePair[]) this.possiblyCacheNewPair(p, side);
      this.redo = 2;
      return true;
    }
    // use_cached_pairs
    for (const side of [1, 2] as const)
      for (const [from, to] of this.cachedPairs[side] as Map<string, string | null>) {
        // newer git: a cached rename whose target is gone or resolved is dropped
        if (to) {
          const mi = this.paths.get(to);
          if (!mi || mi.clean) continue;
        }
        this.pairs[side]?.push(
          to
            ? { status: "R", one: { path: from, v: none() }, two: { path: to, v: none() } }
            : { status: "D", one: { path: from, v: none() } },
        );
      }
    // directory renames (merge.directoryRenames=conflict, merge-tree's default)
    let clean = true;
    this.dirRenameClean = true;
    // no directory renames in inner merges
    if (!this.depth)
      for (const side of [1, 2] as const) clean = this.provisionalDirectoryRenames(side) && clean;
    this.handleDirectoryLevelConflicts();
    const collisions: Map<string, string[]>[] = [new Map(), new Map(), new Map()];
    for (const side of [1, 2] as const)
      collisions[side] = this.computeCollisions(
        this.dirRenames[3 - side] as Map<string, string>,
        this.pairs[side] as FilePair[],
      );
    const reported = new Set<string>();
    const combined: FilePair[] = [];
    for (const side of [1, 2] as const)
      for (const p of this.pairs[side] as FilePair[]) {
        if (p.status !== "A" && p.status !== "R") continue;
        const newPath = this.checkForDirectoryRename(p, side, collisions, reported);
        if (p.status !== "R" && newPath === undefined) continue;
        const q: FilePair =
          newPath === undefined
            ? { ...p }
            : {
                ...p,
                one: p.one ?? { path: twoPath(p), v: none() },
                two: { path: newPath, v: (p.two as { v: Version }).v },
              };
        if (newPath !== undefined) this.applyDirectoryRenameModifications(q, twoPath(p), newPath);
        combined.push({ ...q, side });
      }
    combined.sort((a, b) => comparePaths(onePath(a), onePath(b)));
    return (await this.processRenames(combined)) && clean && this.dirRenameClean;
  }

  /** get_provisional_directory_renames: each removed directory's majority destination */
  provisionalDirectoryRenames(side: 1 | 2): boolean {
    let clean = true;
    for (const [sourceDir, counts] of this.dirRenameCount[side] as Map<string, GitStrMap<number>>) {
      let max = 0;
      let badMax = 0;
      let best: string | undefined;
      for (const [targetDir, count] of counts.entries()) {
        if (count === max) badMax = max;
        else if (count > max) {
          max = count;
          best = targetDir;
        }
      }
      if (max === 0) continue;
      if (badMax === max) {
        this.pathMsg(
          sourceDir,
          [],
          `CONFLICT (directory rename split): Unclear where to rename ${sourceDir} to; it was renamed to multiple other directories, with no destination getting a majority of the files.`,
        );
        clean = false;
      } else this.dirRenames[side]?.set(sourceDir, best as string);
    }
    return clean;
  }

  /** handle_directory_level_conflicts: a directory both sides renamed is renamed by neither */
  handleDirectoryLevelConflicts() {
    const one = this.dirRenames[1] as Map<string, string>;
    const two = this.dirRenames[2] as Map<string, string>;
    for (const dir of [...one.keys()])
      if (two.has(dir)) {
        one.delete(dir);
        two.delete(dir);
      }
  }

  /** check_dir_renamed: the deepest renamed directory above `path` */
  checkDirRenamed(path: string, dirRenames: Map<string, string>): [string, string] | undefined {
    // each proper ancestor with a name (never the root), deepest first
    for (let d = path; d.includes("/"); ) {
      d = dirOf(d);
      const to = dirRenames.get(d);
      if (to !== undefined) return [d, to];
    }
    return undefined;
  }

  /** apply_dir_rename */
  applyDirRename([oldDir, newDir]: [string, string], oldPath: string): string {
    const rest = oldPath.slice(oldDir.length + (newDir === "" ? 1 : 0));
    return `${newDir}${rest}`;
  }

  /** compute_collisions: where the other side's directory renames would put this side's paths */
  computeCollisions(dirRenames: Map<string, string>, pairs: FilePair[]): Map<string, string[]> {
    const collisions = new Map<string, string[]>();
    if (!dirRenames.size) return collisions;
    for (const p of pairs) {
      if (p.status !== "A" && p.status !== "R") continue;
      const info = this.checkDirRenamed(twoPath(p), dirRenames);
      if (!info) continue;
      const newPath = this.applyDirRename(info, twoPath(p));
      const list = collisions.get(newPath) ?? [];
      collisions.set(newPath, list);
      if (!list.includes(twoPath(p))) list.push(twoPath(p));
      list.sort(comparePaths);
    }
    return collisions;
  }

  /** check_for_directory_rename and handle_path_level_conflicts */
  checkForDirectoryRename(
    p: FilePair,
    side: 1 | 2,
    collisions: Map<string, string[]>[],
    reported: Set<string>,
  ): string | undefined {
    const path = twoPath(p);
    const dirRenames = this.dirRenames[3 - side] as Map<string, string>;
    const exclusions = this.dirRenames[side] as Map<string, string>;
    if (!dirRenames.size) return undefined;
    if (collisions[3 - side]?.has(path)) return undefined;
    const info = this.checkDirRenamed(path, dirRenames);
    if (!info) return undefined;
    const [oldDir, newDir] = info;
    if (exclusions.has(newDir)) {
      this.pathMsg(
        oldDir,
        [path, newDir],
        `WARNING: Avoiding applying ${oldDir} -> ${newDir} rename to ${path}, because ${newDir} itself was renamed.`,
      );
      return undefined;
    }
    const newPath = this.applyDirRename(info, path);
    const sources = collisions[side]?.get(newPath) as string[];
    const key = `${side}\0${newPath}`;
    // a path the rename cannot place makes the merge unclean (`*clean_merge &= new_path != NULL`)
    if (reported.has(key)) {
      this.dirRenameClean = false;
      return undefined;
    }
    if (this.pathInWay(newPath, 1 << side, p)) {
      reported.add(key);
      this.dirRenameClean = false;
      this.pathMsg(
        newPath,
        sources,
        `CONFLICT (implicit dir rename): Existing file/dir at ${newPath} in the way of implicit directory rename(s) putting the following path(s) there: ${sources.join(", ")}.`,
      );
      return undefined;
    }
    if (sources.length > 1) {
      reported.add(key);
      this.dirRenameClean = false;
      this.pathMsg(
        newPath,
        sources,
        `CONFLICT (implicit dir rename): Cannot map more than one path to ${newPath}; implicit directory renames tried to put these paths there: ${sources.join(", ")}`,
      );
      return undefined;
    }
    return newPath;
  }

  /** path_in_way (newer git also counts a base file at the path, unless it is the rename's source) */
  pathInWay(path: string, sideMask: number, p: FilePair): boolean {
    const mi = this.paths.get(path);
    if (!mi) return false;
    if (mi.clean) return true;
    const ci = mi as Conflict;
    if ((sideMask & (ci.filemask | ci.dirmask)) !== 0) return true;
    return !this.opts.legacyPathInWay && !!(ci.filemask & 1) && onePath(p) !== path;
  }

  /** apply_directory_rename_modifications: the path moves into the renamed directory */
  applyDirectoryRenameModifications(pair: FilePair, oldPath: string, newPath: string) {
    let ci = this.paths.get(oldPath) as Conflict;
    // the directories above the new path that no entry has yet
    const toInsert: string[] = [];
    for (let cur = newPath; cur.includes("/"); ) {
      const parent = dirOf(cur);
      if (this.paths.has(parent)) break;
      toInsert.push(parent);
      cur = parent;
    }
    for (let i = toInsert.length - 1; i >= 0; i--)
      this.paths.set(toInsert[i] as string, {
        conflict: true,
        result: none(),
        isNull: false,
        clean: false,
        stages: [none(), none(), none()],
        pathnames: ["", "", ""],
        filemask: 0,
        dirmask: ci.filemask,
        matchMask: 0,
        dfConflict: false,
        pathConflict: false,
      });
    if (ci.dirmask === 0) this.paths.delete(oldPath);
    else {
      const moved: Conflict = {
        ...ci,
        result: { ...ci.result },
        stages: [{ ...ci.stages[0] }, none(), { ...ci.stages[2] }],
        pathnames: [...ci.pathnames] as [string, string, string],
        dirmask: 0,
      };
      ci.filemask = 0;
      ci.clean = true;
      for (let i = 0; i < 3; i++) if (!(ci.dirmask & (1 << i))) ci.stages[i] = none();
      ci = moved;
    }
    const branchWithNewPath = ci.filemask === 2 ? this.opts.ours : this.opts.theirs;
    const branchWithDirRename = ci.filemask === 2 ? this.opts.theirs : this.opts.ours;
    const existing = this.paths.get(newPath) as Conflict | undefined;
    if (!existing) this.paths.set(newPath, ci);
    else {
      existing.filemask |= ci.filemask;
      if (existing.dirmask) existing.dfConflict = true;
      const index = ci.filemask >> 1;
      existing.pathnames[index] = ci.pathnames[index] as string;
      existing.stages[index] = { ...(ci.stages[index] as Version) };
      ci = existing;
    }
    ci.pathConflict = true;
    if (pair.status === "A")
      this.pathMsg(
        newPath,
        [oldPath],
        `CONFLICT (file location): ${oldPath} added in ${branchWithNewPath} inside a directory that was renamed in ${branchWithDirRename}, suggesting it should perhaps be moved to ${newPath}.`,
      );
    else
      this.pathMsg(
        newPath,
        [oldPath],
        `CONFLICT (file location): ${onePath(pair)} renamed to ${oldPath} in ${branchWithNewPath}, inside a directory that was renamed in ${branchWithDirRename}, suggesting it should perhaps be moved to ${newPath}.`,
      );
  }

  async processRenames(renames: FilePair[]): Promise<boolean> {
    let cleanMerge = true;
    for (let i = 0; i < renames.length; i++) {
      const pair = renames[i] as FilePair;
      const oldpath = onePath(pair);
      const newpath = twoPath(pair);
      const oldinfo = this.paths.get(oldpath);
      const newinfo = this.paths.get(newpath);
      // newer git: a rename into itself (a directory rename undoing a rename) is no rename
      if (oldinfo && oldpath === newpath && !this.opts.legacyRenameToSelf) continue;
      if (!oldinfo || oldinfo.clean) continue;
      const next = renames[i + 1];
      if (next && onePath(next) === oldpath) {
        const pathnames: [string, string, string] = [oldpath, newpath, twoPath(next)];
        const base = this.paths.get(pathnames[0]) as Conflict;
        const side1 = this.paths.get(pathnames[1]) as Conflict;
        const side2 = this.paths.get(pathnames[2]) as Conflict;
        if (pathnames[1] === pathnames[2]) {
          // rename/rename(1to1): both sides renamed the same way
          side1.stages[0] = { ...base.stages[0] };
          side1.filemask |= 1;
          base.isNull = true;
          base.clean = true;
          i++;
          continue;
        }
        // rename/rename(1to2)
        const merged = await this.handleContentMerge(
          oldpath,
          base.stages[0],
          side1.stages[1],
          side2.stages[2],
          pathnames,
          1 + 2 * this.depth,
        );
        if (!merged.clean) cleanMerge = false;
        const wasBinaryBlob = !merged.clean && sameVersion(merged.result, side1.stages[1]);
        side1.stages[1] = { ...merged.result };
        side2.stages[2] = wasBinaryBlob ? { ...side2.stages[2] } : { ...merged.result };
        side1.pathConflict = true;
        side2.pathConflict = true;
        base.pathConflict = true;
        this.pathMsg(
          pathnames[0],
          [pathnames[1], pathnames[2]],
          `CONFLICT (rename/rename): ${pathnames[0]} renamed to ${pathnames[1]} in ${this.opts.ours} and to ${pathnames[2]} in ${this.opts.theirs}.`,
        );
        i++;
        continue;
      }
      const oi = oldinfo as Conflict;
      const ni = newinfo as Conflict;
      const targetIndex = pair.side as 1 | 2;
      const otherSourceIndex = (3 - targetIndex) as 1 | 2;
      const oldSidemask = 1 << otherSourceIndex;
      const sourceDeleted = oi.filemask === 1;
      let collision = (ni.filemask & oldSidemask) !== 0;
      const typeChanged =
        !sourceDeleted &&
        isReg(oi.stages[otherSourceIndex].mode) !== isReg(ni.stages[targetIndex].mode);
      if (typeChanged && collision) collision = false;
      const renameBranch = targetIndex === 1 ? this.opts.ours : this.opts.theirs;
      const deleteBranch = targetIndex === 1 ? this.opts.theirs : this.opts.ours;
      if (collision && !sourceDeleted) {
        // rename/add or rename/rename(2to1)
        const pathnames: [string, string, string] = [oldpath, oldpath, oldpath];
        pathnames[targetIndex] = newpath;
        const base = this.paths.get(pathnames[0]) as Conflict;
        const side1 = this.paths.get(pathnames[1]) as Conflict;
        const side2 = this.paths.get(pathnames[2]) as Conflict;
        const merged = await this.handleContentMerge(
          oldpath,
          base.stages[0],
          side1.stages[1],
          side2.stages[2],
          pathnames,
          1 + 2 * this.depth,
        );
        ni.stages[targetIndex] = { ...merged.result };
        if (!merged.clean)
          this.pathMsg(
            newpath,
            [oldpath],
            `CONFLICT (rename involved in collision): rename of ${oldpath} -> ${newpath} has content conflicts AND collides with another path; this may result in nested conflict markers.`,
          );
      } else if (collision && sourceDeleted) {
        ni.pathConflict = true;
        this.pathMsg(
          newpath,
          [oldpath],
          `CONFLICT (rename/delete): ${oldpath} renamed to ${newpath} in ${renameBranch}, but deleted in ${deleteBranch}.`,
        );
      } else {
        ni.stages[0] = { ...oi.stages[0] };
        ni.filemask |= 1;
        ni.pathnames[0] = oldpath;
        if (typeChanged) {
          oi.stages[0] = none();
          oi.filemask &= 6;
        } else if (sourceDeleted) {
          ni.pathConflict = true;
          this.pathMsg(
            newpath,
            [oldpath],
            `CONFLICT (rename/delete): ${oldpath} renamed to ${newpath} in ${renameBranch}, but deleted in ${deleteBranch}.`,
          );
        } else {
          ni.stages[otherSourceIndex] = { ...oi.stages[otherSourceIndex] };
          ni.filemask |= oldSidemask;
          ni.pathnames[otherSourceIndex] = oldpath;
        }
      }
      if (!typeChanged) {
        oi.isNull = true;
        oi.clean = true;
      }
    }
    return cleanMerge;
  }

  // ─── content merges ───────────────────────────────────────────────────────────────────

  async blob(oid: string): Promise<Uint8Array> {
    if (oid === NULL_OID) return new Uint8Array(0);
    const o = await this.repo.objects.get(oid);
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

  /** handle_content_merge (no submodules) */
  async handleContentMerge(
    path: string,
    o: Version,
    a: Version,
    b: Version,
    pathnames: [string, string, string],
    extraMarkerSize: number,
  ): Promise<{ result: Version; clean: boolean }> {
    let clean = true;
    const result = none();
    if (a.mode === b.mode || a.mode === o.mode) result.mode = b.mode;
    else {
      result.mode = a.mode;
      clean = b.mode === o.mode;
    }
    if (a.oid === b.oid || a.oid === o.oid) result.oid = b.oid;
    else if (b.oid === o.oid) result.oid = a.oid;
    else if (isReg(a.mode)) {
      const twoWay = (o.mode & S_IFMT) !== (a.mode & S_IFMT);
      const samePaths = pathnames[0] === pathnames[1] && pathnames[1] === pathnames[2];
      const name1 = samePaths ? this.opts.ours : `${this.opts.ours}:${pathnames[1]}`;
      const name2 = samePaths ? this.opts.theirs : `${this.opts.theirs}:${pathnames[2]}`;
      const r = mergeContent(
        twoWay ? new Uint8Array(0) : await this.blob(o.oid),
        await this.blob(a.oid),
        await this.blob(b.oid),
        {
          ours: name1,
          theirs: name2,
          markerSize: 7 + extraMarkerSize,
          virtualAncestor: this.depth > 0,
        },
        this.opts,
      );
      if (r.binary)
        this.pathMsg(
          path,
          [],
          `warning: Cannot merge binary files: ${path} (${name1} vs. ${name2})`,
        );
      result.oid = await this.repo.objects.put("blob", r.content);
      clean &&= r.conflicts === 0;
      this.pathMsg(path, [], `Auto-merging ${path}`);
    } else if ((a.mode & S_IFMT) === S_IFGITLINK) {
      throw new Error(`submodule merges are out of scope (${path})`);
    } else if (this.depth) {
      // symlinks in an inner merge: the base's, conflicted
      clean = false;
      result.mode = o.mode;
      result.oid = o.oid;
    } else {
      // symlinks: ours, conflicted
      clean = false;
      result.oid = a.oid;
    }
    return { result, clean };
  }

  // ─── process_entries ──────────────────────────────────────────────────────────────────

  children = new Map<string, TreeEntry[]>();

  record(path: string, mi: Merged) {
    if (mi.isNull) return;
    const dir = dirOf(path);
    const list = this.children.get(dir) ?? [];
    this.children.set(dir, list);
    list.push({ mode: mi.result.mode.toString(8), name: baseOf(path), oid: mi.result.oid });
  }

  /** write_completed_directory for one directory: its tree, or nothing when it came out empty */
  async completeDirectory(path: string, mi: Merged) {
    const kids = this.children.get(path);
    this.children.delete(path);
    if (!kids?.length) {
      mi.isNull = true;
      return;
    }
    mi.isNull = false;
    mi.result = { mode: S_IFDIR, oid: await writeRawTree(this.repo, kids) };
  }

  uniquePath(path: string, branch: string): string {
    const base = `${path}~${branch.replace(/\//g, "_")}`;
    let p = base;
    for (let suffix = 0; this.paths.has(p); suffix++) p = `${base}_${suffix}`;
    return p;
  }

  async processEntries(): Promise<string> {
    const plist = [...this.paths.keys()].sort(sortDirsNextToChildren);
    // write_completed_directory runs for every directory with entries below it, whatever the
    // directory's own entry became (a rename source that is also a directory keeps its tree)
    const hasEntries = new Set(plist.map(dirOf));
    for (let k = plist.length - 1; k >= 0; k--) {
      const path = plist[k] as string;
      const mi = this.paths.get(path) as Info;
      if (hasEntries.has(path)) await this.completeDirectory(path, mi);
      if (mi.clean) this.record(path, mi);
      else await this.processEntry(path, mi as Conflict);
    }
    return writeRawTree(this.repo, this.children.get("") ?? []);
  }

  async processEntry(entryPath: string, entry: Conflict) {
    let path = entryPath;
    let ci = entry;
    let dfFileIndex = 0;
    if (ci.dirmask) {
      this.record(path, ci);
      if (ci.filemask === 0) return;
    }
    if (ci.dfConflict && ci.result.mode === 0) {
      // the directory is no longer in the way, but a file needs the place
      ci.dfConflict = false;
      ci.clean = false;
      ci.isNull = false;
      ci.matchMask &= ~ci.dirmask;
      ci.dirmask = 0;
      for (let i = 0; i < 3; i++) if (!(ci.filemask & (1 << i))) ci.stages[i] = none();
    } else if (ci.dfConflict && ci.result.mode !== 0) {
      // the directory stays: the file moves to path~branch
      if (ci.filemask === 1) {
        ci.filemask = 0;
        return;
      }
      const moved: Conflict = {
        ...ci,
        result: { ...ci.result },
        stages: [{ ...ci.stages[0] }, { ...ci.stages[1] }, { ...ci.stages[2] }],
        pathnames: [...ci.pathnames] as [string, string, string],
      };
      moved.matchMask &= ~moved.dirmask;
      moved.dirmask = 0;
      for (let i = 0; i < 3; i++) if (!(moved.filemask & (1 << i))) moved.stages[i] = none();
      dfFileIndex = ci.dirmask & 2 ? 2 : 1;
      const branch = dfFileIndex === 1 ? this.opts.ours : this.opts.theirs;
      const oldPath = path;
      path = this.uniquePath(path, branch);
      this.paths.set(path, moved);
      this.pathMsg(
        path,
        [oldPath],
        `CONFLICT (file/directory): directory in the way of ${oldPath} from ${branch}; moving it to ${path} instead.`,
      );
      ci.filemask = 0;
      ci = moved;
    }

    if (ci.matchMask) {
      ci.clean = !ci.dfConflict && !ci.pathConflict;
      if (ci.matchMask === 6) ci.result = { ...ci.stages[1] };
      else {
        const othermask = 7 & ~ci.matchMask;
        const side = othermask === 4 ? 2 : 1;
        ci.result = { ...ci.stages[side] };
        ci.isNull = !ci.result.mode;
        if (ci.isNull) ci.clean = true;
      }
    } else if (ci.filemask >= 6 && (ci.stages[1].mode & S_IFMT) !== (ci.stages[2].mode & S_IFMT)) {
      if (this.depth) {
        // an inner merge keeps the merge base's version
        ci.clean = false;
        ci.result = { ...ci.stages[0] };
        ci.isNull = ci.result.mode === 0;
        if (!ci.clean) this.conflicted.set(path, ci);
        this.record(path, ci);
        return;
      }
      // distinct types: one or both move aside
      const oMode = ci.stages[0].mode;
      const aMode = ci.stages[1].mode;
      const bMode = ci.stages[2].mode;
      let renameA = false;
      let renameB = false;
      if (isReg(aMode)) renameA = true;
      else if (isReg(bMode)) renameB = true;
      else renameA = renameB = true;
      const aPath = renameA ? this.uniquePath(path, this.opts.ours) : undefined;
      let bPath = renameB ? this.uniquePath(path, this.opts.theirs) : undefined;
      if (renameA && renameB)
        this.pathMsg(
          path,
          [aPath as string, bPath as string],
          `CONFLICT (distinct types): ${path} had different types on each side; renamed both of them so each can be recorded somewhere.`,
        );
      else
        this.pathMsg(
          path,
          [(renameA ? aPath : bPath) as string],
          `CONFLICT (distinct types): ${path} had different types on each side; renamed one of them so each can be recorded somewhere.`,
        );
      ci.clean = false;
      const b: Conflict = {
        ...ci,
        result: { ...ci.stages[2] },
        stages: [{ ...ci.stages[0] }, none(), { ...ci.stages[2] }],
        pathnames: [...ci.pathnames] as [string, string, string],
        filemask: 5,
      };
      if ((bMode & S_IFMT) !== (oMode & S_IFMT)) {
        b.stages[0] = none();
        b.filemask = 4;
      }
      ci.result = { ...ci.stages[1] };
      ci.stages[2] = none();
      ci.filemask = 3;
      if ((aMode & S_IFMT) !== (oMode & S_IFMT)) {
        ci.stages[0] = none();
        ci.filemask = 2;
      }
      if (renameA) this.paths.set(aPath as string, ci);
      if (!renameB) bPath = path;
      this.paths.set(bPath as string, b);
      if (renameA && renameB) this.paths.delete(path);
      this.conflicted.set(bPath as string, b);
      this.record(bPath as string, b);
      if (aPath) path = aPath;
    } else if (ci.filemask >= 6) {
      const merged = await this.handleContentMerge(
        path,
        ci.stages[0],
        ci.stages[1],
        ci.stages[2],
        ci.pathnames,
        this.depth * 2,
      );
      ci.clean = merged.clean && !ci.dfConflict && !ci.pathConflict;
      ci.result = { ...merged.result };
      ci.isNull = merged.result.mode === 0;
      if (merged.clean && ci.dfConflict) {
        ci.filemask = 1 << dfFileIndex;
        ci.stages[dfFileIndex as 1 | 2] = { ...merged.result };
      }
      if (!merged.clean) {
        const reason = ci.filemask === 6 ? "add/add" : "content";
        this.pathMsg(path, [], `CONFLICT (${reason}): Merge conflict in ${path}`);
      }
    } else if (ci.filemask === 3 || ci.filemask === 5) {
      const side = ci.filemask === 5 ? 2 : 1;
      // an inner merge keeps the merge base's version
      ci.result = { ...ci.stages[this.depth ? 0 : side] };
      ci.clean = false;
      const modifyBranch = side === 1 ? this.opts.ours : this.opts.theirs;
      const deleteBranch = side === 1 ? this.opts.theirs : this.opts.ours;
      if (!(ci.pathConflict && ci.stages[0].oid === ci.stages[side].oid))
        this.pathMsg(
          path,
          [],
          `CONFLICT (modify/delete): ${path} deleted in ${deleteBranch} and modified in ${modifyBranch}.  Version ${modifyBranch} of ${path} left in tree.`,
        );
    } else if (ci.filemask === 2 || ci.filemask === 4) {
      const side = ci.filemask === 4 ? 2 : 1;
      ci.result = { ...ci.stages[side] };
      ci.clean = !ci.dfConflict && !ci.pathConflict;
    } else if (ci.filemask === 1) {
      ci.isNull = true;
      ci.result = none();
      ci.clean = !ci.pathConflict;
    }
    if (!ci.clean) this.conflicted.set(path, ci);
    this.record(path, ci);
  }

  // ─── merge_ort_nonrecursive_internal ──────────────────────────────────────────────────

  async run(trees: (string | undefined)[]): Promise<TreeMergeResult> {
    let clean: boolean;
    for (;;) {
      await this.collectMergeInfo(trees);
      clean = await this.detectAndProcessRenames();
      if (this.redo !== 2) break;
      this.reset();
    }
    const tree = await this.processEntries();
    const conflicts: ConflictEntry[] = [];
    for (const path of [...this.conflicted.keys()].sort(comparePaths)) {
      const ci = this.conflicted.get(path) as Conflict;
      for (let i = 0; i < 3; i++)
        if (ci.filemask & (1 << i))
          conflicts.push({
            mode: (ci.stages[i] as Version).mode.toString(8).padStart(6, "0"),
            oid: (ci.stages[i] as Version).oid,
            stage: (i + 1) as 1 | 2 | 3,
            path,
          });
    }
    const messages: MergeMessage[] = [];
    for (const path of [...this.messages.keys()].sort(comparePaths))
      messages.push(...(this.messages.get(path) as MergeMessage[]));
    return { tree, clean: clean && this.conflicted.size === 0, conflicts, messages };
  }
}

function entryOf(v: Version) {
  return { mode: v.mode.toString(8), oid: v.oid };
}

/** `git merge-tree --write-tree` of `ours` and `theirs` over `base` (no base: unrelated histories) */
export async function mergeOrt(
  repo: Repository,
  base: string | undefined,
  ours: string,
  theirs: string,
  opts: TreeMergeOptions,
  /** call_depth: deeper than 0 for merges of merge bases (X13f) */
  depth = 0,
): Promise<TreeMergeResult> {
  return new OrtMerge(repo, opts, depth).run([base, ours, theirs]);
}
