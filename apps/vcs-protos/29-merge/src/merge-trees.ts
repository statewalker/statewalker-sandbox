/**
 * X13b — merge-ort's tree merge without rename detection (`git merge-tree --write-tree
 * -Xno-renames`): the merged tree, with conflicted files' blobs carrying their markers; the
 * conflicted entries (stages 1, 2, 3 per path); and ort's messages.
 *
 * Path by path (merge-ort.c `process_entry`): a path both sides left as the base had, or changed
 * alike, takes that; a path one side changed takes that side (a deletion included); a path both
 * changed is merged — modes, then content (X13a) for regular files, ours kept for symlinks that
 * conflict — or is a modify/delete or add/add conflict; types that differ (file, symlink,
 * submodule) put each side at `path~<branch>`. A file that survives where the merged tree has a
 * directory moves to `path~<branch of the file>` (file/directory).
 */

import { readTree, writeTree } from "../../17-repository/src/commands.js";
import type { TreeEntry } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import type { XdOptions } from "./xdiff.js";
import { mergeContent } from "./xmerge.js";

export interface Entry {
  mode: string;
  oid: string;
}
export interface ConflictEntry extends Entry {
  stage: 1 | 2 | 3;
  path: string;
}
export interface MergeMessage {
  /** the paths it is about (the first is where it is listed) */
  paths: string[];
  text: string;
}
export interface TreeMergeResult {
  tree: string;
  clean: boolean;
  conflicts: ConflictEntry[];
  messages: MergeMessage[];
}
export interface TreeMergeOptions extends XdOptions {
  /** branch names: conflict markers, `path~<branch>` names, messages */
  ours: string;
  theirs: string;
}

const isTree = (mode: string) => mode === "40000" || mode === "040000";
const typeOf = (mode: string) =>
  mode === "120000" ? "link" : mode === "160000" ? "gitlink" : "file";
const same = (a?: Entry, b?: Entry) =>
  a === b || (!!a && !!b && a.mode === b.mode && a.oid === b.oid);

/** path → entry for every non-tree entry, and the set of directories */
async function flatten(repo: Repository, oid: string | undefined): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  if (!oid) return out;
  const walk = async (tree: string, prefix: string) => {
    for (const e of await readTree(repo, tree)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (isTree(e.mode)) await walk(e.oid, path);
      else out.set(path, { mode: normalizeMode(e.mode), oid: e.oid });
    }
  };
  await walk(oid, "");
  return out;
}
function normalizeMode(mode: string): string {
  return mode.replace(/^0+/, "");
}

async function blob(repo: Repository, oid: string): Promise<Uint8Array> {
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

/** writes nested trees for path → entry */
async function buildTree(repo: Repository, files: Map<string, Entry>): Promise<string> {
  type Dir = Map<string, Dir | Entry>;
  const root: Dir = new Map();
  for (const [path, entry] of files) {
    const parts = path.split("/");
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      let next = dir.get(p);
      if (!next) {
        next = new Map();
        dir.set(p, next);
      }
      if (!(next instanceof Map)) throw new Error(`merge: ${path} under a file`);
      dir = next;
    }
    dir.set(parts[parts.length - 1] as string, entry);
  }
  const write = async (dir: Dir): Promise<string> => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of dir) {
      if (v instanceof Map) entries.push({ mode: "40000", name, oid: await write(v) });
      else entries.push({ mode: v.mode, name, oid: v.oid });
    }
    return writeTree(repo, entries);
  };
  return write(root);
}

/** `path~branch`, made unique as merge-ort's unique_path does (`_0`, `_1`, …) */
function uniquePath(taken: (p: string) => boolean, path: string, branch: string): string {
  const base = `${path}~${branch.replace(/\//g, "_")}`;
  if (!taken(base)) return base;
  for (let i = 0; ; i++) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
}

/**
 * Directories merge-ort resolves whole, without looking inside (merge-ort.c
 * `collect_merge_info_callback` defers a directory one side left as the base had, or one only a
 * side has; `handle_deferred_entries` then takes the other side's directory as it is, unless rename
 * detection may need a source deleted on that side). Their paths get no file/directory moves.
 */
function trivialDirectoryMerges(sides: Map<string, Entry>[], dirsOf: Set<string>[]): Set<string> {
  const children = new Map<string, Set<string>>();
  for (const m of sides)
    for (const path of m.keys()) {
      const parts = path.split("/");
      for (let i = 0; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        let set = children.get(dir);
        if (!set) children.set(dir, (set = new Set()));
        set.add(parts.slice(0, i + 1).join("/"));
      }
    }
  const sigCache = new Map<string, string>();
  const signature = (i: number, dir: string) => {
    const key = `${i}\0${dir}`;
    let sig = sigCache.get(key);
    if (sig === undefined) {
      const lines: string[] = [];
      for (const [p, e] of sides[i] as Map<string, Entry>)
        if (p.startsWith(`${dir}/`)) lines.push(`${p} ${e.mode} ${e.oid}`);
      sig = lines.sort().join("\n");
      sigCache.set(key, sig);
    }
    return sig;
  };
  const isFile = (i: number, p: string) => (sides[i] as Map<string, Entry>).has(p);
  const isDir = (i: number, p: string) => (dirsOf[i] as Set<string>).has(p);
  const matches = (i: number, j: number, p: string) =>
    isFile(i, p)
      ? same(sides[i]?.get(p), sides[j]?.get(p))
      : isDir(i, p) && isDir(j, p) && signature(i, p) === signature(j, p);
  const relevant = [false, false, false]; // a rename source deleted on side 1 / 2
  const deferred: [number, string, number][] = []; // [side, directory, dir_rename_mask]
  const trivial = new Set<string>();

  // dir_rename_mask: in a directory one side removed, a file the other side added makes every
  // deletion below a rename source relevant for directory renames (0x07)
  const visit = (dir: string, mask: number) => {
    const names = [...(children.get(dir) ?? [])].sort();
    const fileMask = (p: string) => [0, 1, 2].reduce((m, i) => m | (isFile(i, p) ? 1 << i : 0), 0);
    const dirMask = (p: string) => [0, 1, 2].reduce((m, i) => m | (isDir(i, p) ? 1 << i : 0), 0);
    if (mask !== 0 && mask !== 7 && names.some((p) => fileMask(p) === mask)) mask = 7;
    for (const p of names) {
      const fm = fileMask(p);
      const dm = dirMask(p);
      const m1 = (fm | dm) & 1 && matches(1, 0, p);
      const m2 = (fm | dm) & 1 && matches(2, 0, p);
      if (m1 && m2) continue;
      const sidesMatch = !m1 && !m2 && ((fm | dm) & 6) === 6 && matches(1, 2, p);
      const matchMask = m1 ? 3 : m2 ? 5 : sidesMatch ? 6 : 0;
      if (fm === 7 && (sidesMatch || m1 || m2)) continue;
      let here = mask;
      if (here !== 7 && (dm === 3 || dm === 5)) here = dm & ~1;
      if (fm !== 0 && fm !== 7)
        for (const s of [1, 2])
          if (fm & 1 && !(fm & (1 << s)) && ((matchMask & fm) === 0 || here === 7))
            relevant[s] = true;
      if (!dm) continue;
      let side = m1 ? 2 : m2 ? 1 : 0;
      if (fm === 0 && (dm === 2 || dm === 4)) side = dm / 2;
      if (here !== 7 && side !== 0) deferred.push([side, p, here]);
      else visit(p, here);
    }
  };
  visit("", 0);
  for (const side of [1, 2]) {
    const okay = !relevant[side];
    for (let k = 0; k < deferred.length; k++) {
      const [s, p, mask] = deferred[k] as [number, string, number];
      if (s !== side) continue;
      if (okay) trivial.add(p);
      else visit(p, mask);
    }
  }
  return trivial;
}

/** a file's place in the merge: its versions, and what the merge made of it (merge-ort's conflict_info) */
interface Slot {
  /** the versions in play (0 base, 1 ours, 2 theirs), only for sides with a file here */
  stages: (Entry | undefined)[];
  result?: Entry;
  clean: boolean;
}
interface Pending {
  path: string;
  extra: string[];
  render: (p: string) => string;
}

const dirsAbove = (paths: Iterable<string>) => {
  const d = new Set<string>();
  for (const p of paths)
    for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) d.add(p.slice(0, i));
  return d;
};

export async function mergeTrees(
  repo: Repository,
  base: string | undefined,
  ours: string,
  theirs: string,
  opts: TreeMergeOptions,
): Promise<TreeMergeResult> {
  const sides = await Promise.all([
    flatten(repo, base),
    flatten(repo, ours),
    flatten(repo, theirs),
  ]);
  const dirsOf = sides.map((m) => dirsAbove(m.keys()));
  const branch = (side: 1 | 2) => (side === 1 ? opts.ours : opts.theirs);
  /** final path → slot (distinct types place theirs here at once; the rest after file/directory) */
  const slots = new Map<string, Slot>();
  /** messages about a path, rendered with the path it ends at (a file/directory move renames it) */
  const pending: Pending[] = [];
  const say = (path: string, render: (p: string) => string, extra: string[] = []) =>
    pending.push({ path, extra, render });

  /** handle_content_merge: modes, then content (regular files) or ours (symlinks, submodules) */
  const contentMerge = async (path: string, o: Entry | undefined, a: Entry, b: Entry) => {
    let clean = true;
    let mode: string;
    if (a.mode === b.mode || a.mode === o?.mode) mode = b.mode;
    else {
      mode = a.mode;
      clean = b.mode === o?.mode;
    }
    let oid: string;
    if (a.oid === b.oid || a.oid === o?.oid) oid = b.oid;
    else if (b.oid === o?.oid) oid = a.oid;
    else if (typeOf(a.mode) === "file") {
      const twoWay = !o || typeOf(o.mode) !== typeOf(a.mode);
      const r = mergeContent(
        twoWay ? new Uint8Array(0) : await blob(repo, (o as Entry).oid),
        await blob(repo, a.oid),
        await blob(repo, b.oid),
        { ours: opts.ours, theirs: opts.theirs },
        opts,
      );
      oid = await repo.objects.put("blob", r.content);
      if (r.binary)
        say(
          path,
          (p) => `warning: Cannot merge binary files: ${p} (${opts.ours} vs. ${opts.theirs})\n`,
        );
      clean &&= r.conflicts === 0;
      say(path, (p) => `Auto-merging ${p}\n`);
    } else {
      // symlinks (submodules are not merged here): ours, conflicted
      oid = a.oid;
      clean = false;
    }
    return { result: { mode, oid }, clean };
  };

  const filePaths = [...new Set(sides.flatMap((m) => [...m.keys()]))].sort();
  const outcome = new Map<string, Slot>();
  for (const path of filePaths) {
    const st = sides.map((m) => m.get(path));
    const [o, a, b] = st;
    const slot: Slot = { stages: st, clean: true };
    if (same(a, b)) slot.result = a;
    else if (same(o, a)) slot.result = b;
    else if (same(o, b)) slot.result = a;
    else if (a && b && typeOf(a.mode) !== typeOf(b.mode)) {
      // distinct types: the regular file moves aside (both, when neither is one)
      let renameA = typeOf(a.mode) === "file";
      let renameB = !renameA && typeOf(b.mode) === "file";
      if (!renameA && !renameB) renameA = renameB = true;
      const taken = (q: string) =>
        slots.has(q) || sides.some((m) => m.has(q)) || dirsOf.some((d) => d.has(q));
      const aPath = renameA ? uniquePath(taken, path, opts.ours) : undefined;
      const bPath = renameB
        ? uniquePath((q) => taken(q) || q === aPath, path, opts.theirs)
        : undefined;
      say(
        path,
        (p) =>
          `CONFLICT (distinct types): ${p} had different types on each side; renamed ${aPath && bPath ? "both of them" : "one of them"} so each can be recorded somewhere.\n`,
        [...(aPath ? [aPath] : []), ...(bPath ? [bPath] : [])],
      );
      const keepBase = (e: Entry) => (o && typeOf(e.mode) === typeOf(o.mode) ? o : undefined);
      slots.set(aPath ?? path, { stages: [keepBase(a), a, undefined], result: a, clean: false });
      slots.set(bPath ?? path, { stages: [keepBase(b), undefined, b], result: b, clean: false });
      continue;
    } else if (a && b) {
      const r = await contentMerge(path, o, a, b);
      slot.result = r.result;
      slot.clean = r.clean;
      if (!r.clean)
        say(path, (p) => `CONFLICT (${o ? "content" : "add/add"}): Merge conflict in ${p}\n`);
    } else if (o && (a || b)) {
      const side: 1 | 2 = a ? 1 : 2;
      slot.result = (a ?? b) as Entry;
      slot.clean = false;
      say(
        path,
        (p) =>
          `CONFLICT (modify/delete): ${p} deleted in ${branch(side === 1 ? 2 : 1)} and modified in ${branch(side)}.  Version ${branch(side)} of ${p} left in tree.\n`,
      );
    }
    outcome.set(path, slot);
  }

  // file/directory: ort moves a file aside, before merging it, whenever the merged tree keeps a
  // directory at its path and ours or theirs still has the file — even if the merge then drops it
  const mergedDirs = dirsAbove([
    ...[...outcome].filter(([, sl]) => sl.result).map(([p]) => p),
    ...slots.keys(),
  ]);
  const finalPath = new Map<string, string>();
  let uncleanDropped = false;
  const messages: MergeMessage[] = [];
  const trivial = trivialDirectoryMerges(sides, dirsOf);
  const underTrivial = (path: string) => {
    for (let at = path.length; at > 0; at = path.lastIndexOf("/", at - 1))
      if (trivial.has(path.slice(0, at))) return true;
    return false;
  };
  for (const [path, sl] of outcome) {
    if (!mergedDirs.has(path) || !(sl.stages[1] || sl.stages[2]) || underTrivial(path)) {
      if (sl.result) slots.set(path, sl);
      continue;
    }
    const side: 1 | 2 = dirsOf[1]?.has(path) ? 2 : 1; // the side without the directory
    const moved = uniquePath(
      (q) =>
        slots.has(q) || outcome.has(q) || mergedDirs.has(q) || [...finalPath.values()].includes(q),
      path,
      branch(side),
    );
    finalPath.set(path, moved);
    messages.push({
      paths: [moved, path],
      text: `CONFLICT (file/directory): directory in the way of ${path} from ${branch(side)}; moving it to ${moved} instead.\n`,
    });
    if (!sl.result) {
      // a moved file the merge deletes is clean in ort (is_null); anything else stays a conflict
      if (!sl.clean) uncleanDropped = true;
      continue;
    }
    // a clean result that has to move is a conflict; ort keeps the moved side's stages
    let stages = sl.stages;
    if (sl.clean) {
      const [, sa, sb] = sl.stages;
      if (sa && sb)
        stages = same(sa, sb)
          ? [undefined, sa, sb]
          : side === 1
            ? [undefined, sl.result, undefined]
            : [undefined, undefined, sl.result];
      else stages = [undefined, sa, sb];
    }
    slots.set(moved, { stages, result: sl.result, clean: false });
  }
  for (const m of pending) {
    const to = finalPath.get(m.path) ?? m.path;
    messages.push({ paths: [to, ...m.extra], text: m.render(to) });
  }

  const merged = new Map<string, Entry>();
  const conflicts: ConflictEntry[] = [];
  let clean = true;
  for (const [path, sl] of slots) {
    if (sl.result) merged.set(path, sl.result);
    if (sl.clean) continue;
    clean = false;
    sl.stages.forEach((e, i) => {
      if (e) conflicts.push({ ...e, stage: (i + 1) as 1 | 2 | 3, path });
    });
  }
  if (uncleanDropped) clean = false;
  conflicts.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : x.stage - y.stage));
  // by the path each is listed under; a stable sort keeps a path's own order
  messages.sort((x, y) => {
    const p = x.paths[0] as string;
    const q = y.paths[0] as string;
    return p < q ? -1 : p > q ? 1 : 0;
  });
  return { tree: await buildTree(repo, merged), clean, conflicts, messages };
}
