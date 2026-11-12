/**
 * X15 — merge, cherry-pick and rebase that stop where git stops and leave git's own state files
 * (sequencer.c, builtin/merge.c, the merge backend of builtin/rebase.c), so native git can finish
 * what we started and we can finish what git started. Nothing is kept in memory between steps: an
 * operation resumes from `.git` after a reload.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { readCommit, readTree, commit as writeCommit } from "../../17-repository/src/commands.js";
import { encodeTree, type Person, type TreeEntry } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import type { ConflictEntry, TreeMergeOptions } from "../../29-merge/src/merge-trees.js";
import { mergeOrt } from "../../31-ort/src/ort.js";
import { mergeBases, mergeCommits } from "../../33-criss-cross/src/recursive.js";
import {
  compareEntries,
  type IndexEntry,
  type IndexFile,
  parseIndex,
  serializeIndex,
} from "../../34-index/src/index-file.js";
import {
  addAll,
  type StatInfo,
  smudgeRacy,
  statFields,
  status,
  type Worktree,
} from "../../34-index/src/worktree.js";

export interface Session {
  repo: Repository;
  /** the .git directory: state files and the index */
  git: FilesApi;
  wt: Worktree;
  author: Person;
  committer: Person;
  /** merge options for the git version being matched (X13's probes) */
  mergeOptions?: Partial<TreeMergeOptions>;
  /**
   * merge-ort writes AUTO_MERGE after every merge that updates the worktree (2.43 and 2.56 alike),
   * so a clean cherry-pick (or rebase pick) leaves it behind; a probe tells
   */
  legacyAutoMerge?: boolean;
  /**
   * git's sequencer removes REBASE_HEAD and AUTO_MERGE before each pick, so a rebase that stopped
   * on its last pick leaves REBASE_HEAD behind (2.43; 2.56's source does the same). False: they are
   * removed once at the start of each run instead
   */
  legacyRebaseHead?: boolean;
  /** git 2.43 writes todo lines as `pick <id> <subject>`; newer git (2.56) as `pick <id> # <subject>` */
  legacyTodoFormat?: boolean;
  /**
   * git 2.43 writes `rebase-merge/message` as the commit message and a newline; newer git (2.56)
   * writes the message with the conflict list, as in MERGE_MSG
   */
  legacyRebaseMessage?: boolean;
}
export interface OpResult {
  status: "clean" | "fast-forward" | "up-to-date" | "conflict" | "stopped" | "done";
  commit?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const STOP_FILES = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "CHERRY_PICK_HEAD"];
const RM = "/rebase-merge";

// ---------------------------------------------------------------- files

async function readBytes(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  const parts: Uint8Array[] = [];
  for await (const c of files.read(path)) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  const b = await readBytes(files, path);
  return b && dec.decode(b);
}
async function writeText(files: FilesApi, path: string, text: string) {
  await files.write(path, [enc.encode(text)]);
}
async function removeFiles(files: FilesApi, paths: string[]) {
  for (const p of paths) if (await files.exists(p)) await files.remove(p);
}
async function blob(repo: Repository, oid: string): Promise<Uint8Array> {
  const o = await repo.objects.get(oid);
  if (!o) throw new Error(`no object ${oid}`);
  const parts: Uint8Array[] = [];
  for await (const c of o.content) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------- trees and the index

interface FileEntry {
  mode: number;
  oid: string;
}
async function flatten(repo: Repository, tree: string): Promise<Map<string, FileEntry>> {
  const out = new Map<string, FileEntry>();
  const walk = async (t: string, prefix: string) => {
    for (const e of await readTree(repo, t)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      const mode = Number.parseInt(e.mode, 8);
      if (mode === 0o40000) await walk(e.oid, path);
      else out.set(path, { mode, oid: e.oid });
    }
  };
  await walk(tree, "");
  return out;
}

async function readIndex(s: Session): Promise<IndexFile> {
  const bytes = await readBytes(s.git, "/index");
  return bytes ? parseIndex(bytes) : { version: 2, entries: [], extensions: [] };
}
/**
 * Writes the index once the clock has passed every entry's mtime, as git avoids racy entries: an
 * entry no newer than the index file would have to be smudged (size 0), and git's
 * `reset --merge` (`merge --abort`) refuses smudged entries as "not uptodate".
 */
async function writeIndex(s: Session, index: IndexFile) {
  let newest = 0;
  for (const e of index.entries)
    if (e.stage === 0) newest = Math.max(newest, e.mtimeSec * 1000 + Math.ceil(e.mtimeNsec / 1e6));
  while (Date.now() <= newest) await new Promise((r) => setTimeout(r, 1));
  await s.git.write("/index", [serializeIndex(smudgeRacy(index, Date.now()))]);
}
async function indexTimestamp(s: Session): Promise<number> {
  const st = await s.git.stats("/index");
  return st?.kind === "file" ? st.lastModified : 0;
}

/** write-tree: the stage-0 entries as nested trees */
async function writeIndexTree(repo: Repository, entries: IndexEntry[]): Promise<string> {
  type Dir = Map<string, Dir | IndexEntry>;
  const root: Dir = new Map();
  for (const e of entries) {
    if (e.stage) throw new Error(`${e.path}: unmerged`);
    const parts = e.path.split("/");
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      let next = dir.get(p);
      if (!next || !(next instanceof Map)) {
        next = new Map();
        dir.set(p, next);
      }
      dir = next;
    }
    dir.set(parts[parts.length - 1] as string, e);
  }
  const write = async (dir: Dir): Promise<string> => {
    const out: TreeEntry[] = [];
    for (const [name, v] of dir) {
      if (v instanceof Map) out.push({ mode: "40000", name, oid: await write(v) });
      else out.push({ mode: v.mode.toString(8), name, oid: v.oid });
    }
    return repo.objects.put("tree", encodeTree(out));
  };
  return write(root);
}

async function statOf(wt: Worktree, path: string): Promise<StatInfo | undefined> {
  if (wt.stat) return wt.stat(`/${path}`);
  const st = await wt.files.stats(`/${path}`);
  return st?.kind === "file" ? { size: st.size, mtimeMs: st.lastModified } : undefined;
}

async function removeEmptyParents(files: FilesApi, path: string) {
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const dir = `/${path.slice(0, i)}`;
    if ((await files.stats(dir))?.kind !== "directory") continue;
    let empty = true;
    for await (const _ of files.list(dir)) {
      empty = false;
      break;
    }
    if (!empty) return;
    await files.remove(dir);
  }
}

/**
 * Moves the working tree and the index from `from` to `to` (unpack_trees, two-way): files that
 * differ are written, files gone are removed, unchanged entries keep their stat data; conflicted
 * paths get their stages instead of a stage-0 entry.
 */
async function checkout(
  s: Session,
  from: string,
  to: string,
  conflicts: ConflictEntry[] = [],
  reset = false,
) {
  const old = await flatten(s.repo, from);
  const next = await flatten(s.repo, to);
  const index = await readIndex(s);
  const kept = new Map<string, IndexEntry>();
  const indexed = new Set<string>();
  for (const e of index.entries) {
    indexed.add(e.path);
    if (e.stage === 0) kept.set(e.path, e);
  }
  // verify_absent: a file the operation would create must not be there untracked
  if (!reset)
    for (const path of next.keys()) {
      if (old.has(path) || indexed.has(path)) continue;
      const st = await s.wt.files.stats(`/${path}`);
      if (!st) continue;
      if (st.kind === "file")
        throw new Error(`untracked working tree file would be overwritten: ${path}`);
      for await (const f of s.wt.files.list(`/${path}`, { recursive: true }))
        if (f.kind === "file" && !old.has(f.path.replace(/^\//, "")))
          throw new Error(`untracked working tree file would be removed: ${f.path}`);
    }
  // a reset also drops what the index holds beyond `from` (a stopped merge's files)
  const gone = new Set([...old.keys(), ...(reset ? indexed : [])]);
  for (const path of gone)
    if (!next.has(path)) {
      await s.wt.files.remove(`/${path}`);
      await removeEmptyParents(s.wt.files, path);
    }
  const conflicted = new Set(conflicts.map((c) => c.path));
  const entries: IndexEntry[] = [];
  for (const [path, e] of next) {
    const before = old.get(path);
    const prev = kept.get(path);
    const same =
      before && before.oid === e.oid && before.mode === e.mode && prev?.oid === e.oid && !reset;
    if (!same) {
      // a directory in the way of a file (or the other way round) goes first
      const st = await s.wt.files.stats(`/${path}`);
      if (st?.kind === "directory") await s.wt.files.remove(`/${path}`);
      await s.wt.files.write(`/${path}`, [await blob(s.repo, e.oid)]);
    }
    if (conflicted.has(path)) continue;
    if (same && prev) {
      entries.push(prev);
      continue;
    }
    const st = await statOf(s.wt, path);
    if (!st) throw new Error(`${path}: not written`);
    entries.push({
      ...statFields(st),
      mode: e.mode,
      oid: e.oid,
      stage: 0,
      assumeValid: false,
      skipWorktree: false,
      intentToAdd: false,
      path,
    });
  }
  for (const c of conflicts)
    entries.push({
      ctimeSec: 0,
      ctimeNsec: 0,
      mtimeSec: 0,
      mtimeNsec: 0,
      dev: 0,
      ino: 0,
      uid: 0,
      gid: 0,
      size: 0,
      mode: Number.parseInt(c.mode, 8),
      oid: c.oid,
      stage: c.stage,
      assumeValid: false,
      skipWorktree: false,
      intentToAdd: false,
      path: c.path,
    });
  entries.sort(compareEntries);
  await writeIndex(s, { version: index.version === 4 ? 4 : 2, entries, extensions: [] });
}

// ---------------------------------------------------------------- refs and commits

async function head(s: Session): Promise<{ oid: string; branch?: string }> {
  const v = await s.repo.refs.read("HEAD");
  const oid = await s.repo.refs.resolve("HEAD");
  if (!oid) throw new Error("HEAD does not point at a commit");
  return { oid, branch: v && "symref" in v ? v.symref : undefined };
}
async function treeOf(s: Session, commit: string): Promise<string> {
  return (await readCommit(s.repo, commit)).tree;
}
interface Rev {
  oid: string;
  /** the full ref name, when the revision named one */
  ref?: string;
}
/** a revision as git's dwim_ref reads it: a ref, a short name, or a full commit id */
async function resolveRev(s: Session, name: string): Promise<Rev> {
  const candidates = name.startsWith("refs/")
    ? [name]
    : [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`];
  for (const ref of candidates) {
    if (ref === name && !name.startsWith("refs/") && name !== "HEAD") continue;
    const oid = await s.repo.refs.resolve(ref);
    if (!oid) continue;
    const o = await s.repo.objects.get(oid);
    if (o) {
      await o.content[Symbol.asyncIterator]().return?.();
      if (o.type === "tag") throw new Error(`${name}: merging annotated tags is not handled`);
    }
    return { oid, ref };
  }
  if (/^[0-9a-f]{40}$/.test(name) && (await s.repo.objects.has(name))) return { oid: name };
  throw new Error(`${name}: unknown revision`);
}
async function mustResolve(s: Session, name: string): Promise<string> {
  return (await resolveRev(s, name)).oid;
}

/** fmt-merge-msg's title: what was merged, and ` into <branch>` unless main/master */
function mergeTitle(name: string, rev: Rev, branch: string | undefined): string {
  const what = rev.ref?.startsWith("refs/heads/")
    ? `branch '${rev.ref.slice(11)}'`
    : rev.ref?.startsWith("refs/remotes/")
      ? `remote-tracking branch '${rev.ref.slice(13)}'`
      : rev.ref?.startsWith("refs/tags/")
        ? `tag '${rev.ref.slice(10)}'`
        : `commit '${name}'`;
  const into = branch ? branch.replace(/^refs\/heads\//, "") : "HEAD";
  return `Merge ${what}${into !== "main" && into !== "master" ? ` into ${into}` : ""}\n`;
}
async function moveHead(s: Session, from: string, to: string, detach = false) {
  // detaching replaces HEAD itself, whose old value may be a symbolic ref: no id to compare
  const r = await s.repo.refs.batch([
    detach ? { name: "HEAD", new: to, noDeref: true } : { name: "HEAD", old: from, new: to },
  ]);
  if (!r.ok) throw new Error(`HEAD: ${r.rejected.map((x) => x.reason).join(", ")}`);
}
async function newCommit(
  s: Session,
  tree: string,
  parents: string[],
  message: string,
  author: Person,
): Promise<string> {
  const { oid, result } = await writeCommit(s.repo, {
    ref: "HEAD",
    tree,
    parents,
    author,
    committer: s.committer,
    message,
  });
  if (!result.ok) throw new Error("HEAD moved during the commit");
  return oid;
}

/** the local changes git would refuse to overwrite: here, any change to tracked files */
async function requireClean(s: Session, headTree: string) {
  const r = await status(s.repo, s.wt, await readIndex(s), headTree, await indexTimestamp(s));
  const dirty = r.lines.filter((l) => !l.startsWith("??"));
  if (dirty.length) throw new Error(`local changes would be overwritten: ${dirty.join(", ")}`);
}

const subject = (message: string) => message.split("\n")[0] as string;
const short = (oid: string) => oid.slice(0, 7);
/** `# Conflicts:` with each conflicted path once, in index order */
function conflictList(conflicts: ConflictEntry[]): string {
  const paths = [...new Set(conflicts.map((c) => c.path))].sort((a, b) =>
    compareEntries({ path: a, stage: 0 } as IndexEntry, { path: b, stage: 0 } as IndexEntry),
  );
  return `\n# Conflicts:\n${paths.map((p) => `#\t${p}\n`).join("")}`;
}

/** strbuf_stripspace: trailing spaces, runs of blank lines, leading and trailing blank lines */
function stripspace(message: string, stripComments: boolean): string {
  const out: string[] = [];
  let blank = 0;
  for (const raw of message.split("\n")) {
    if (stripComments && raw.startsWith("#")) continue;
    const line = raw.replace(/\s+$/, "");
    if (!line) {
      blank++;
      continue;
    }
    if (out.length && blank) out.push("");
    blank = 0;
    out.push(line);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

function mergeOpts(s: Session, ours: string, theirs: string): TreeMergeOptions {
  return { ...s.mergeOptions, ours, theirs } as TreeMergeOptions;
}

// ---------------------------------------------------------------- merge

/** `git merge <branch>` */
export async function merge(s: Session, ref: string): Promise<OpResult> {
  const h = await head(s);
  const rev = await resolveRev(s, ref);
  const theirs = rev.oid;
  const headTree = await treeOf(s, h.oid);
  await requireClean(s, headTree);
  const bases = await mergeBases(s.repo, h.oid, theirs);
  await writeText(s.git, "/ORIG_HEAD", `${h.oid}\n`);
  if (bases.includes(theirs)) return { status: "up-to-date" };
  const theirTree = await treeOf(s, theirs);
  if (bases.includes(h.oid)) {
    await checkout(s, headTree, theirTree);
    await moveHead(s, h.oid, theirs);
    return { status: "fast-forward", commit: theirs };
  }
  const name = ref.replace(/^refs\/heads\//, "");
  const message = mergeTitle(name, rev, h.branch);
  const r = await mergeCommits(s.repo, h.oid, theirs, mergeOpts(s, "HEAD", name));
  await checkout(s, headTree, r.tree, r.clean ? [] : r.conflicts);
  if (r.clean) {
    const oid = await newCommit(s, r.tree, [h.oid, theirs], message, s.author);
    return { status: "clean", commit: oid };
  }
  await writeText(s.git, "/MERGE_HEAD", `${theirs}\n`);
  await writeText(s.git, "/MERGE_MSG", message + conflictList(r.conflicts));
  await writeText(s.git, "/MERGE_MODE", "");
  await writeText(s.git, "/AUTO_MERGE", `${r.tree}\n`);
  return { status: "conflict" };
}

// ---------------------------------------------------------------- cherry-pick

interface Picked {
  status: "committed" | "dropped" | "conflict";
  conflicts?: ConflictEntry[];
  tree?: string;
  commit?: string;
}

/**
 * do_pick_commit: a three-way merge of the commit onto HEAD, with its parent as the base. A rebase
 * drops a pick that becomes empty (`--empty=drop`). git also fast-forwards a pick whose parent is
 * HEAD; `git rebase <upstream>` never meets one (its first pick's parent is the fork point, not
 * `onto`), so that path (needed with `--onto`) is not here.
 */
async function pickOnto(s: Session, pick: string, rebasing: boolean): Promise<Picked> {
  const h = await head(s);
  const c = await readCommit(s.repo, pick);
  const headTree = await treeOf(s, h.oid);
  const parent = c.parents[0];
  const baseTree = parent ? await treeOf(s, parent) : undefined;
  const r = await mergeOrt(
    s.repo,
    baseTree,
    headTree,
    c.tree,
    mergeOpts(s, "HEAD", `${short(pick)} (${subject(c.message)})`),
  );
  await checkout(s, headTree, r.tree, r.clean ? [] : r.conflicts);
  if (!r.clean) return { status: "conflict", conflicts: r.conflicts, tree: r.tree };
  if (s.legacyAutoMerge) await writeText(s.git, "/AUTO_MERGE", `${r.tree}\n`);
  if (rebasing && r.tree === headTree && c.tree !== baseTree) return { status: "dropped" };
  const commit = await newCommit(s, r.tree, [h.oid], c.message, c.author);
  return { status: "committed", commit };
}

/** `git cherry-pick <commit>` */
export async function cherryPick(s: Session, revision: string): Promise<OpResult> {
  const commit = await mustResolve(s, revision);
  const h = await head(s);
  await requireClean(s, await treeOf(s, h.oid));
  const r = await pickOnto(s, commit, false);
  if (r.status !== "conflict") return { status: "clean", commit: (await head(s)).oid };
  const c = await readCommit(s.repo, commit);
  await writeText(s.git, "/CHERRY_PICK_HEAD", `${commit}\n`);
  // append_conflicts_hint: the list goes right after the message as it is
  await writeText(s.git, "/MERGE_MSG", c.message + conflictList(r.conflicts ?? []));
  await writeText(s.git, "/AUTO_MERGE", `${r.tree}\n`);
  return { status: "conflict" };
}

// ---------------------------------------------------------------- finishing and aborting

/** `git add -A` */
export async function addAllOp(s: Session): Promise<void> {
  const index = await readIndex(s);
  const next = await addAll(s.repo, s.wt, index, await indexTimestamp(s));
  await writeIndex(s, next);
}

/** `git commit --no-edit` of a resolved merge or cherry-pick */
export async function commitOp(s: Session): Promise<OpResult> {
  const h = await head(s);
  const index = await readIndex(s);
  const tree = await writeIndexTree(s.repo, index.entries);
  const message = stripspace((await readText(s.git, "/MERGE_MSG")) ?? "", false);
  const mergeHead = (await readText(s.git, "/MERGE_HEAD"))?.trim();
  const pick = (await readText(s.git, "/CHERRY_PICK_HEAD"))?.trim();
  let oid: string;
  if (mergeHead) oid = await newCommit(s, tree, [h.oid, mergeHead], message, s.author);
  else if (pick) {
    if (tree === (await treeOf(s, h.oid)))
      throw new Error(
        "The previous cherry-pick is now empty, possibly due to conflict resolution.",
      );
    oid = await newCommit(s, tree, [h.oid], message, (await readCommit(s.repo, pick)).author);
  } else throw new Error("nothing to commit: no merge or cherry-pick in progress");
  await removeFiles(
    s.git,
    STOP_FILES.map((f) => `/${f}`),
  );
  return { status: "done", commit: oid };
}

/** reset --hard (`--merge` for a clean stop): the working tree and index back to a commit */
async function resetTo(s: Session, target: string) {
  const h = await head(s);
  await checkout(s, await treeOf(s, h.oid), await treeOf(s, target), [], true);
}

/** `git merge --abort` / `git rebase --abort` */
export async function abortOp(s: Session): Promise<OpResult> {
  const headName = (await readText(s.git, `${RM}/head-name`))?.trim();
  if (headName) {
    const orig = (await readText(s.git, `${RM}/orig-head`))?.trim() as string;
    await resetTo(s, orig);
    const h = await head(s);
    if (!(await s.repo.refs.setSymref("HEAD", headName)))
      throw new Error("HEAD: could not reattach");
    void h;
    await removeTree(s.git, RM);
    await removeFiles(s.git, ["/REBASE_HEAD", ...STOP_FILES.map((f) => `/${f}`)]);
    return { status: "done" };
  }
  const h = await head(s);
  await resetTo(s, h.oid);
  await removeFiles(
    s.git,
    STOP_FILES.map((f) => `/${f}`),
  );
  return { status: "done" };
}

async function removeTree(files: FilesApi, dir: string) {
  if ((await files.stats(dir))?.kind !== "directory") return;
  const all: string[] = [];
  for await (const e of files.list(dir, { recursive: true })) all.push(e.path);
  for (const p of all.reverse()) await files.remove(p);
  await files.remove(dir);
}

// ---------------------------------------------------------------- rebase

const sq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
function authorScript(p: Person): string {
  return `GIT_AUTHOR_NAME=${sq(p.name)}\nGIT_AUTHOR_EMAIL=${sq(p.email)}\nGIT_AUTHOR_DATE=${sq(`@${p.when} ${p.tz}`)}\n`;
}
function parseAuthorScript(text: string): Person {
  const get = (k: string) => {
    const m = new RegExp(`^${k}='((?:[^']|'\\\\'')*)'$`, "m").exec(text);
    return (m?.[1] ?? "").replace(/'\\''/g, "'");
  };
  const [when, tz] = get("GIT_AUTHOR_DATE").replace(/^@/, "").split(" ");
  return {
    name: get("GIT_AUTHOR_NAME"),
    email: get("GIT_AUTHOR_EMAIL"),
    when: Number(when),
    tz: tz as string,
  };
}
const todoLine = async (s: Session, oid: string) =>
  s.legacyTodoFormat
    ? await plainTodoLine(s, oid)
    : `pick ${oid} # ${subject((await readCommit(s.repo, oid)).message).replace(/\s+$/, "")}\n`;
const plainTodoLine = async (s: Session, oid: string) =>
  `pick ${oid} ${subject((await readCommit(s.repo, oid)).message).replace(/\s+$/, "")}\n`;
function parseTodo(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^(?:pick|p)\s+([0-9a-f]{40})\b/.exec(line.trim());
    if (m) out.push(m[1] as string);
  }
  return out;
}

/** the commits of `upstream..head`, oldest first (a linear branch) */
async function rebaseList(s: Session, upstream: string, tip: string): Promise<string[]> {
  const upstreamSide = new Set<string>();
  const stack = [upstream];
  while (stack.length) {
    const c = stack.pop() as string;
    if (upstreamSide.has(c)) continue;
    upstreamSide.add(c);
    stack.push(...(await readCommit(s.repo, c)).parents);
  }
  const out: string[] = [];
  for (let c: string | undefined = tip; c && !upstreamSide.has(c); ) {
    const data = await readCommit(s.repo, c);
    // git replays the merged-in side's commits too (rev-list --topo-order --no-merges): not ported
    if (data.parents.length > 1)
      throw new Error(`rebase: ${c} is a merge commit; branches with merges are not handled`);
    out.push(c);
    c = data.parents[0];
  }
  return out.reverse();
}

/** `git rebase <upstream>` (merge backend) */
export async function rebase(s: Session, upstream: string): Promise<OpResult> {
  const h = await head(s);
  if (!h.branch) throw new Error("rebase: HEAD is detached");
  const onto = await mustResolve(s, upstream);
  const headTree = await treeOf(s, h.oid);
  await requireClean(s, headTree);
  const bases = await mergeBases(s.repo, h.oid, onto);
  if (bases.includes(onto)) return { status: "up-to-date" };
  const todo = await rebaseList(s, onto, h.oid);
  await checkout(s, headTree, await treeOf(s, onto)); // refuses before any state is written
  await writeText(s.git, "/ORIG_HEAD", `${h.oid}\n`);
  await writeText(s.git, `${RM}/head-name`, `${h.branch}\n`);
  await writeText(s.git, `${RM}/onto`, `${onto}\n`);
  await writeText(s.git, `${RM}/orig-head`, `${h.oid}\n`);
  await writeText(s.git, `${RM}/interactive`, "");
  await writeText(s.git, `${RM}/drop_redundant_commits`, "");
  await writeText(s.git, `${RM}/no-reschedule-failed-exec`, "");
  let lines = "";
  for (const c of todo) lines += await todoLine(s, c);
  await writeText(s.git, `${RM}/git-rebase-todo`, lines);
  await writeText(s.git, `${RM}/end`, `${todo.length}\n`);
  await moveHead(s, h.oid, onto, true);
  return runTodo(s);
}

/** rewritten-list: each picked commit and its copy, for post-rewrite and notes */
async function rewritten(s: Session, from: string, to: string) {
  const old = (await readText(s.git, `${RM}/rewritten-list`)) ?? "";
  await writeText(s.git, `${RM}/rewritten-list`, `${old}${from} ${to}\n`);
}

/** pick the todo list's commits until it is empty (done) or a pick conflicts (stopped) */
async function runTodo(s: Session): Promise<OpResult> {
  if (!s.legacyRebaseHead) await removeFiles(s.git, ["/REBASE_HEAD", "/AUTO_MERGE"]);
  for (;;) {
    const todo = parseTodo((await readText(s.git, `${RM}/git-rebase-todo`)) ?? "");
    const next = todo[0];
    if (!next) return finishRebase(s);
    const done = ((await readText(s.git, `${RM}/done`)) ?? "") + (await todoLine(s, next));
    const rest = (await readText(s.git, `${RM}/git-rebase-todo`)) ?? "";
    await writeText(s.git, `${RM}/done`, done);
    await writeText(s.git, `${RM}/git-rebase-todo`, rest.slice(rest.indexOf("\n") + 1));
    await writeText(s.git, `${RM}/msgnum`, `${done.split("\n").filter(Boolean).length}\n`);
    if (s.legacyRebaseHead) await removeFiles(s.git, ["/REBASE_HEAD"]); // gone with the next pick
    const r = await pickOnto(s, next, true);
    if (r.status === "committed") await rewritten(s, next, r.commit as string);
    if (r.status !== "conflict") continue;
    const c = await readCommit(s.repo, next);
    await writeText(s.git, `${RM}/author-script`, authorScript(c.author));
    const hinted = c.message + conflictList(r.conflicts ?? []);
    await writeText(s.git, `${RM}/message`, s.legacyRebaseMessage ? `${c.message}\n` : hinted);
    await writeText(s.git, `${RM}/stopped-sha`, `${next}\n`);
    await writeText(s.git, "/REBASE_HEAD", `${next}\n`);
    await writeText(s.git, "/MERGE_MSG", c.message + conflictList(r.conflicts ?? []));
    await writeText(s.git, "/AUTO_MERGE", `${r.tree}\n`);
    return { status: "stopped" };
  }
}

async function finishRebase(s: Session): Promise<OpResult> {
  const headName = (await readText(s.git, `${RM}/head-name`))?.trim() as string;
  const orig = (await readText(s.git, `${RM}/orig-head`))?.trim() as string;
  const h = await head(s);
  const r = await s.repo.refs.batch([{ name: headName, old: orig, new: h.oid }]);
  if (!r.ok) throw new Error(`${headName}: moved during the rebase`);
  if (!(await s.repo.refs.setSymref("HEAD", headName))) throw new Error("HEAD: could not reattach");
  await removeTree(s.git, RM);
  // git 2.43 leaves the last pick's AUTO_MERGE
  const left = STOP_FILES.filter((f) => !(s.legacyAutoMerge && f === "AUTO_MERGE"));
  await removeFiles(
    s.git,
    left.map((f) => `/${f}`),
  ); // REBASE_HEAD stays where git 2.43 leaves it
  return { status: "done", commit: h.oid };
}

/** `git rebase --continue` (or, for a merge or cherry-pick, `git commit`) */
export async function continueOp(s: Session): Promise<OpResult> {
  if ((await s.git.stats(RM))?.kind !== "directory") return commitOp(s);
  const index = await readIndex(s);
  if (index.entries.some((e) => e.stage)) throw new Error("rebase: unmerged paths");
  const stopped = (await readText(s.git, "/REBASE_HEAD"))?.trim();
  if (stopped) {
    const h = await head(s);
    const tree = await writeIndexTree(s.repo, index.entries);
    if (tree !== (await treeOf(s, h.oid))) {
      const author = parseAuthorScript((await readText(s.git, `${RM}/author-script`)) ?? "");
      const message = stripspace((await readText(s.git, "/MERGE_MSG")) ?? "", true);
      await rewritten(s, stopped, await newCommit(s, tree, [h.oid], message, author));
    }
    await removeFiles(s.git, [
      "/MERGE_MSG",
      "/AUTO_MERGE",
      `${RM}/author-script`,
      `${RM}/message`,
      `${RM}/stopped-sha`,
    ]);
  }
  return runTodo(s);
}
