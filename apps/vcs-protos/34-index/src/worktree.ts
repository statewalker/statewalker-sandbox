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
  /** `git status --porcelain=v1 --untracked-files=all --no-renames` lines, sorted */
  lines: string[];
  /** how many files were read and hashed */
  hashed: number;
  /** the index with refreshed stat data */
  index: IndexFile;
}

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const enc = new TextEncoder();

/** every regular file of the working tree (outside .git), with its stat */
async function scan(wt: Worktree): Promise<Map<string, StatInfo>> {
  const out = new Map<string, StatInfo>();
  for await (const e of wt.files.list("/", { recursive: true })) {
    const path = e.path.replace(/^\//, "");
    if (e.kind !== "file" || path === ".git" || path.startsWith(".git/")) continue;
    const st = wt.stat ? await wt.stat(e.path) : { size: e.size, mtimeMs: e.lastModified };
    if (st) out.set(path, st);
  }
  return out;
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

function blobId(data: Uint8Array): string {
  return toHex(
    createSha1("noble")
      .update(enc.encode(`blob ${data.length}\0`))
      .update(data)
      .digest(),
  );
}

/** the stat fields of an entry, from what the stat source knows */
function statFields(
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

/** stages every file of the working tree (`git add -A`); racy entries are smudged (size 0) */
export async function addAll(
  repo: Repository,
  wt: Worktree,
  index: IndexFile | undefined,
  indexTimestampMs: number,
): Promise<IndexFile> {
  const files = await scan(wt);
  const old = new Map<string, IndexEntry>();
  for (const e of index?.entries ?? []) if (!old.has(e.path) || e.stage === 0) old.set(e.path, e);
  const entries: IndexEntry[] = [];
  for (const [path, st] of files) {
    const prev = old.get(path);
    let oid: string;
    if (prev && prev.stage === 0 && !prev.intentToAdd && !mustHash(prev, st, indexTimestampMs))
      oid = prev.oid;
    else oid = await repo.objects.put("blob", await readAll(wt.files, path));
    const e: IndexEntry = {
      ...statFields(st),
      mode: prev?.mode ?? 0o100644,
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

/** `git status` of the working tree against the index and HEAD's tree */
export async function status(
  repo: Repository,
  wt: Worktree,
  index: IndexFile,
  head: string | undefined,
  indexTimestampMs: number,
): Promise<StatusResult> {
  const files = await scan(wt);
  const headFiles = await flattenTree(repo, head);
  const lines: string[] = [];
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
    if (e.intentToAdd) x = " ";
    else if (inHead === undefined) x = "A";
    else if (inHead !== `${e.mode.toString(8)} ${e.oid}`) x = "M";
    // working tree against the index
    let y = " ";
    let entry = e;
    if (e.intentToAdd) y = files.has(e.path) ? "A" : "D";
    else if (!e.skipWorktree && !e.assumeValid) {
      const st = files.get(e.path);
      if (!st) y = "D";
      else if (mustHash(e, st, indexTimestampMs)) {
        hashed++;
        const oid = blobId(await readAll(wt.files, e.path));
        if (oid !== e.oid) y = "M";
        else entry = { ...e, ...statFields(st) }; // refresh: the same content, new stat data
      }
    }
    refreshed.push(entry);
    if (x !== " " || y !== " ") lines.push(`${x}${y} ${e.path}`);
  }
  for (const [path, stages] of unmerged) lines.push(`${unmergedCode(stages)} ${path}`);
  // in HEAD, gone from the index
  for (const path of headFiles.keys()) if (!inIndex.has(path)) lines.push(`D  ${path}`);
  for (const path of files.keys()) if (!inIndex.has(path)) lines.push(`?? ${path}`);
  lines.sort();
  return { lines, hashed, index: { ...index, entries: refreshed } };
}

/** smudges entries racily clean against the time the index is written (not implemented) */
export function smudgeRacy(index: IndexFile, _writeTimestampMs: number): IndexFile {
  return index;
}
