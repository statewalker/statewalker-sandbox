/**
 * X14 — a working tree on a FilesApi: staging (`git add -A`) and status against the index and HEAD.
 *
 * The index caches each file's stat data. A file whose stat still matches is not read (git's
 * `ie_match_stat`); a file whose mtime is not older than the index file itself is "racily clean"
 * and is read anyway (`is_racy_timestamp`); an entry recorded with size 0 for a non-empty blob was
 * smudged and is read too. FilesApi reports a size and a millisecond mtime; a richer stat source
 * (Node's lstat) fills every field git writes. Modes come from the index (FilesApi has no
 * executable bit or symlinks: git's `core.fileMode=false`, `core.symlinks=false`).
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { createSha1, toHex } from "../../01-streaming-git-hash/src/git-object-hash.js";
import { readTree } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { compareEntries, type IndexEntry, type IndexFile } from "./index-file.js";

/** what a stat source reports for a file (FilesApi: size and lastModified only) */
export interface StatInfo {
  size: number;
  mtimeMs: number;
  /** a symlink (lstat), whose blob is its target */
  symlink?: boolean;
  /** full lstat, where the platform has it */
  mtimeNs?: bigint;
  ctimeNs?: bigint;
  dev?: number;
  ino?: number;
  uid?: number;
  gid?: number;
}
export interface Worktree {
  files: FilesApi;
  /** a richer stat than the FilesApi's, where the platform has one */
  stat?: (path: string) => Promise<StatInfo | undefined>;
  /** a symlink's target, where the platform has symlinks */
  readLink?: (path: string) => Promise<string>;
}
export interface StatusResult {
  /** `git status --porcelain=v1 --untracked-files=all --no-renames` lines, in git's order */
  lines: string[];
  /** how many files were read and hashed */
  hashed: number;
  /** the index with refreshed stat data (smudge it with `smudgeRacy` when writing it) */
  index: IndexFile;
}

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const GITLINK = 0o160000;
const SYMLINK = 0o120000;
const enc = new TextEncoder();

interface Scan {
  files: Map<string, StatInfo>;
  /** directories holding a repository of their own (a `.git` inside) */
  nested: Set<string>;
}

/** every file of the working tree outside .git, nested repositories and the index's gitlinks */
async function scan(wt: Worktree, gitlinks: Set<string>, symlinks: string[]): Promise<Scan> {
  const listed: { path: string; size: number; lastModified: number }[] = [];
  const nested = new Set<string>();
  for await (const e of wt.files.list("/", { recursive: true })) {
    const path = e.path.replace(/^\//, "");
    const parts = path.split("/");
    const at = parts.indexOf(".git");
    if (at > 0) nested.add(parts.slice(0, at).join("/"));
    if (at >= 0 || e.kind !== "file") continue;
    listed.push({ path, size: e.size ?? 0, lastModified: e.lastModified ?? 0 });
  }
  const roots = new Set([...nested, ...gitlinks]);
  const inside = (path: string) => {
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1))
      if (roots.has(path.slice(0, i))) return true;
    return false;
  };
  const files = new Map<string, StatInfo>();
  for (const e of listed) {
    if (inside(e.path)) continue;
    const st = wt.stat ? await wt.stat(`/${e.path}`) : { size: e.size, mtimeMs: e.lastModified };
    if (st) files.set(e.path, st);
  }
  // a dangling symlink is not listed (a FilesApi follows links): the index's symlinks are asked for
  if (wt.stat && wt.readLink)
    for (const path of symlinks)
      if (!files.has(path)) {
        const st = await wt.stat(`/${path}`);
        if (st?.symlink) files.set(path, st);
      }
  return { files, nested };
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(`/${path}`)) {
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

/** what the blob of a working-tree file holds: its bytes, or a symlink's target */
async function content(wt: Worktree, path: string, st: StatInfo): Promise<Uint8Array> {
  if (st.symlink && wt.readLink) return enc.encode(await wt.readLink(`/${path}`));
  return readAll(wt.files, path);
}

function blobId(data: Uint8Array): string {
  return toHex(
    createSha1("noble")
      .update(enc.encode(`blob ${data.length}\0`))
      .update(data)
      .digest(),
  );
}

/** the stat fields of an entry, from what the stat source knows */
export function statFields(
  st: StatInfo,
): Pick<
  IndexEntry,
  "ctimeSec" | "ctimeNsec" | "mtimeSec" | "mtimeNsec" | "dev" | "ino" | "uid" | "gid" | "size"
> {
  const split = (ns: bigint) => ({
    sec: Number(ns / 1_000_000_000n),
    nsec: Number(ns % 1_000_000_000n),
  });
  const m =
    st.mtimeNs !== undefined
      ? split(st.mtimeNs)
      : { sec: Math.floor(st.mtimeMs / 1000), nsec: Math.round((st.mtimeMs % 1000) * 1e6) };
  const c = st.ctimeNs !== undefined ? split(st.ctimeNs) : m;
  return {
    ctimeSec: c.sec >>> 0,
    ctimeNsec: c.nsec >>> 0,
    mtimeSec: m.sec >>> 0,
    mtimeNsec: m.nsec >>> 0,
    dev: (st.dev ?? 0) >>> 0,
    ino: (st.ino ?? 0) >>> 0,
    uid: (st.uid ?? 0) >>> 0,
    gid: (st.gid ?? 0) >>> 0,
    size: st.size >>> 0,
  };
}

/** match_stat_data on what both sides know */
function statMatches(e: IndexEntry, st: StatInfo): boolean {
  const f = statFields(st);
  if (e.size !== f.size) return false;
  if (st.mtimeNs !== undefined) {
    if (e.mtimeSec !== f.mtimeSec || e.mtimeNsec !== f.mtimeNsec) return false;
    if (st.ctimeNs !== undefined && (e.ctimeSec !== f.ctimeSec || e.ctimeNsec !== f.ctimeNsec))
      return false;
    if (st.ino !== undefined && e.ino !== f.ino) return false;
    if (st.dev !== undefined && e.dev !== f.dev) return false;
    if (st.uid !== undefined && e.uid !== f.uid) return false;
    if (st.gid !== undefined && e.gid !== f.gid) return false;
    return true;
  }
  // milliseconds only: the entry's mtime at millisecond precision
  return e.mtimeSec * 1000 + Math.floor(e.mtimeNsec / 1e6) === Math.floor(st.mtimeMs);
}

/** is_racy_timestamp: the entry's mtime is not older than the index file */
function isRacy(e: IndexEntry, indexTimestampMs: number): boolean {
  return indexTimestampMs > 0 && e.mtimeSec * 1000 + e.mtimeNsec / 1e6 >= indexTimestampMs;
}

/** whether the file must be read to know if it changed */
function mustHash(e: IndexEntry, st: StatInfo, indexTimestampMs: number): boolean {
  if (!statMatches(e, st)) return true;
  if (isRacy(e, indexTimestampMs)) return true;
  return e.size === 0 && e.oid !== EMPTY_BLOB; // smudged
}

/** ce_smudge_racily_clean_entry for every entry, against the time the index is written */
export function smudgeRacy(index: IndexFile, writeTimestampMs: number): IndexFile {
  return {
    ...index,
    entries: index.entries.map((e) =>
      e.stage === 0 && e.size !== 0 && isRacy(e, writeTimestampMs) ? { ...e, size: 0 } : e,
    ),
  };
}

/** ce_mode_from_stat with core.fileMode=false: the index's mode for regular files */
function modeOf(wt: Worktree, st: StatInfo, prev: IndexEntry | undefined): number {
  if (st.symlink) return SYMLINK;
  if (!prev) return 0o100644;
  if (prev.mode === 0o100755 || prev.mode === 0o100644) return prev.mode;
  if (prev.mode === SYMLINK && !wt.readLink) return SYMLINK; // core.symlinks=false
  return 0o100644;
}

/** entries `git add -A` leaves as they are: skip-worktree, assume-unchanged, gitlinks */
function keptAsIs(e: IndexEntry): boolean {
  return e.stage === 0 && (e.skipWorktree || e.assumeValid || e.mode === GITLINK);
}

/** stages every file of the working tree (`git add -A`); racy entries are smudged (size 0) */
export async function addAll(
  repo: Repository,
  wt: Worktree,
  index: IndexFile | undefined,
  indexTimestampMs: number,
): Promise<IndexFile> {
  const kept = (index?.entries ?? []).filter(keptAsIs);
  const gitlinks = new Set(kept.filter((e) => e.mode === GITLINK).map((e) => e.path));
  const symlinks = (index?.entries ?? []).filter((e) => e.mode === SYMLINK).map((e) => e.path);
  const { files, nested } = await scan(wt, gitlinks, symlinks);
  for (const n of nested)
    if (!gitlinks.has(n)) throw new Error(`${n}: a nested repository (submodules are not handled)`);
  const keptPaths = new Set(kept.map((e) => e.path));
  const stage0 = new Map<string, IndexEntry>();
  for (const e of index?.entries ?? []) if (e.stage === 0) stage0.set(e.path, e);
  const entries: IndexEntry[] = [...kept];
  for (const [path, st] of files) {
    if (keptPaths.has(path)) continue;
    const prev = stage0.get(path);
    let oid: string;
    if (prev && !prev.intentToAdd && !mustHash(prev, st, indexTimestampMs)) oid = prev.oid;
    else oid = await repo.objects.put("blob", await content(wt, path, st));
    const e: IndexEntry = {
      ...statFields(st),
      mode: modeOf(wt, st, prev),
      oid,
      stage: 0,
      assumeValid: false,
      skipWorktree: false,
      intentToAdd: false,
      path,
    };
    if (isRacy(e, indexTimestampMs)) e.size = 0; // ce_smudge_racily_clean_entry
    entries.push(e);
  }
  entries.sort(compareEntries);
  return { version: index?.version === 4 ? 4 : 2, entries, extensions: [] };
}

async function flattenTree(
  repo: Repository,
  oid: string | undefined,
): Promise<Map<string, IndexEntry["oid"] & string>> {
  const out = new Map<string, string>();
  if (!oid) return out;
  const walk = async (tree: string, prefix: string) => {
    for (const e of await readTree(repo, tree)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (/^0*40000$/.test(e.mode)) await walk(e.oid, path);
      else out.set(path, `${Number.parseInt(e.mode, 8).toString(8)} ${e.oid}`);
    }
  };
  await walk(oid, "");
  return out;
}

/** the porcelain code of an unmerged path, from the stages it has */
function unmergedCode(stages: Set<number>): string {
  const key = [1, 2, 3].map((s) => (stages.has(s) ? "1" : "0")).join("");
  return (
    {
      "100": "DD",
      "010": "AU",
      "110": "UD",
      "001": "UA",
      "101": "DU",
      "011": "AA",
      "111": "UU",
    } as Record<string, string>
  )[key] as string;
}

/** quote_c_style with QUOTE_PATH_QUOTE_SP and core.quotePath=true */
export function quotePath(path: string): string {
  const bytes = enc.encode(path);
  const esc: Record<number, string> = {
    7: "\\a",
    8: "\\b",
    9: "\\t",
    10: "\\n",
    11: "\\v",
    12: "\\f",
    13: "\\r",
    34: '\\"',
    92: "\\\\",
  };
  let quoted = false;
  let out = "";
  for (const b of bytes) {
    if (b < 0x20 || b === 0x22 || b === 0x5c || b >= 0x7f) {
      quoted = true;
      out += esc[b] ?? `\\${b.toString(8).padStart(3, "0")}`;
    } else {
      if (b === 0x20) quoted = true;
      out += String.fromCharCode(b);
    }
  }
  return quoted ? `"${out}"` : path;
}

function compareBytes(a: string, b: string): number {
  const x = enc.encode(a);
  const y = enc.encode(b);
  for (let i = 0; i < x.length && i < y.length; i++)
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
}

/** `git status` of the working tree against the index and HEAD's tree */
export async function status(
  repo: Repository,
  wt: Worktree,
  index: IndexFile,
  head: string | undefined,
  indexTimestampMs: number,
): Promise<StatusResult> {
  const gitlinks = new Set(
    index.entries.filter((e) => e.stage === 0 && e.mode === GITLINK).map((e) => e.path),
  );
  const symlinks = index.entries.filter((e) => e.mode === SYMLINK).map((e) => e.path);
  const { files, nested } = await scan(wt, gitlinks, symlinks);
  const headFiles = await flattenTree(repo, head);
  // tracked and unmerged paths in path order, then untracked ones (wt-status.c)
  const changes = new Map<string, string>();
  const untracked: string[] = [];
  let hashed = 0;
  const inIndex = new Set<string>();
  const unmerged = new Map<string, Set<number>>();
  const refreshed: IndexEntry[] = [];
  for (const e of index.entries) {
    inIndex.add(e.path);
    if (e.stage) {
      const s = unmerged.get(e.path) ?? new Set<number>();
      s.add(e.stage);
      unmerged.set(e.path, s);
      refreshed.push(e);
      continue;
    }
    // index against HEAD
    const inHead = headFiles.get(e.path);
    let x = " ";
    if (e.intentToAdd) x = inHead === undefined ? " " : "D";
    else if (inHead === undefined) x = "A";
    else if (inHead !== `${e.mode.toString(8)} ${e.oid}`) x = "M";
    // working tree against the index
    let y = " ";
    let entry = e;
    if (e.intentToAdd) y = files.has(e.path) ? "A" : "D";
    else if (e.mode === GITLINK)
      y = nested.has(e.path) ? " " : "D"; // the submodule's own state is not read
    else if (!e.skipWorktree && !e.assumeValid) {
      const st = files.get(e.path);
      if (!st) y = "D";
      else if (mustHash(e, st, indexTimestampMs)) {
        hashed++;
        const oid = blobId(await content(wt, e.path, st));
        if (oid !== e.oid) y = "M";
        else entry = { ...e, ...statFields(st) }; // refresh: the same content, new stat data
      }
    }
    refreshed.push(entry);
    if (x !== " " || y !== " ") changes.set(e.path, `${x}${y}`);
  }
  for (const [path, stages] of unmerged) changes.set(path, unmergedCode(stages));
  // in HEAD, gone from the index
  for (const path of headFiles.keys()) if (!inIndex.has(path)) changes.set(path, "D ");
  for (const path of files.keys()) if (!inIndex.has(path)) untracked.push(path);
  for (const n of nested) if (!gitlinks.has(n)) untracked.push(`${n}/`);
  const lines = [...changes.keys()]
    .sort(compareBytes)
    .map((p) => `${changes.get(p)} ${quotePath(p)}`);
  for (const p of untracked.sort(compareBytes)) lines.push(`?? ${quotePath(p)}`);
  return { lines, hashed, index: { ...index, entries: refreshed } };
}
