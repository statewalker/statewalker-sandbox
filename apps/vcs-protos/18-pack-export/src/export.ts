/**
 * X6c — pack export over X16a's Repository (git files or SQL): `listObjects` (see
 * listObjectsWithEdges) chooses the objects, `writePack` streams them.
 *
 * `writePack` writes a version-2 pack of whole objects, pulled by the consumer: an object is
 * opened only when the consumer asks for the bytes after the previous one, its content streams
 * through a deflater (memory: a deflate window; for compressible data the deflater may read a
 * whole small object before its first output), the pack's SHA-1 runs over the output, and the
 * AbortSignal is checked between chunks — it throws the signal's reason (an AbortError unless the
 * caller aborted with another value). Leaving the generator early releases the open object's
 * stream. The object list is fixed before writing: a gc that removes a listed object during the
 * export fails it mid-stream.
 */
import { sha1 } from "@noble/hashes/legacy.js";
import { Deflate } from "pako";
import { readCommit, readTree } from "../../17-repository/src/commands.js";
import { type CommitData, isTreeMode, parseTagTarget } from "../../17-repository/src/git-format.js";
import type { ObjectType, Repository } from "../../17-repository/src/object-store.js";

export interface ToSend {
  oid: string;
  type: ObjectType;
  /** The path a tree or blob was reached by (as `rev-list --objects` prints it): for delta search. */
  path?: string;
}

export interface WalkOptions {
  signal?: AbortSignal;
  /**
   * Commits whose parents are not followed (the receiver's shallow boundary, or this repository's
   * own `.git/shallow`). Any other missing object fails the walk, as git's does.
   */
  shallow?: Iterable<string>;
}

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
/** git's SLOP: commits still walked once only uninteresting ones are queued (clock skew). */
const SLOP = 5;

async function typeOf(
  repo: Repository,
  oid: string,
): Promise<{ type: ObjectType; bytes?: Uint8Array } | undefined> {
  const o = await repo.objects.get(oid);
  if (!o) return undefined;
  if (o.type !== "tag") {
    await o.content[Symbol.asyncIterator]().return?.();
    return { type: o.type };
  }
  const parts: Uint8Array[] = [];
  for await (const c of o.content) parts.push(c);
  const bytes = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let p = 0;
  for (const c of parts) {
    bytes.set(c, p);
    p += c.length;
  }
  return { type: "tag", bytes };
}

/** Follows tags; returns the tags passed and the object they end at (undefined: absent). */
async function peel(repo: Repository, oid: string, tags: string[]): Promise<ToSend | undefined> {
  for (let i = 0; i < 16; i++) {
    const t = await typeOf(repo, oid);
    if (!t) return undefined;
    if (t.type !== "tag") return { oid, type: t.type };
    tags.push(oid);
    oid = parseTagTarget(t.bytes as Uint8Array).object;
  }
  throw new Error(`tag chain too long at ${oid}`);
}

/**
 * The objects to send for `wants` given the receiver's `haves`, with the walk's edges
 * (uninteresting parents of sent commits: the bases a thin pack may delta against).
 *
 * Commits: git's limited walk (revision.c limit_list) — one queue by committer date over both
 * sides, uninteresting propagated to parents, stopped once only uninteresting commits are queued
 * and none is as new as an interesting commit found (then SLOP more for clock skew): an
 * incremental export reads the commits near the tips, not the whole history. A have this repository lacks is ignored (a receiver may claim anything); a
 * missing want or parent fails unless below a declared shallow commit.
 *
 * Trees and blobs: those of the sent commits, minus everything reachable from the trees of the
 * haves and of the edges — git's `rev-list --objects-edge-aggressive` set (plain `rev-list
 * --objects` marks only the edges' trees and sends more; the difference is objects the receiver
 * has). Trees, blobs and tags given as haves are uninteresting themselves.
 */
export async function listObjectsWithEdges(
  repo: Repository,
  wants: string[],
  haves: string[],
  opts: WalkOptions = {},
): Promise<{ objects: ToSend[]; edges: string[] }> {
  const signal = opts.signal;
  const shallow = new Set(opts.shallow ?? []);
  const out: ToSend[] = [];
  const seen = new Set<string>();
  const add = (o: ToSend) => {
    if (seen.has(o.oid)) return false;
    seen.add(o.oid);
    out.push(o);
    return true;
  };
  const uninterestingObjects = new Set<string>();

  // --- commits: the limited walk
  type State = { u: boolean; commit: CommitData; popped: boolean; order: number };
  const state = new Map<string, State>();
  const queue: string[] = [];
  let order = 0;
  const enqueue = (oid: string) => {
    const s = state.get(oid) as State;
    let i = queue.length;
    while (i > 0) {
      const o = state.get(queue[i - 1] as string) as State;
      if (o.commit.committer.when > s.commit.committer.when) break;
      if (o.commit.committer.when === s.commit.committer.when && o.order < s.order) break;
      i--;
    }
    queue.splice(i, 0, oid);
  };
  const markUninteresting = (oid: string) => {
    const stack = [oid];
    while (stack.length) {
      const x = stack.pop() as string;
      const s = state.get(x);
      if (!s || s.u) continue;
      s.u = true;
      if (s.popped && !shallow.has(x)) stack.push(...s.commit.parents);
    }
  };
  /** false: absent (only allowed for uninteresting commits) */
  const visit = async (oid: string, u: boolean): Promise<boolean> => {
    signal?.throwIfAborted();
    const known = state.get(oid);
    if (known) {
      if (u) markUninteresting(oid);
      return true;
    }
    if (!(await repo.objects.has(oid))) {
      if (u) return false;
      throw new Error(
        `commit ${oid} is missing (not in this repository, not below a shallow commit)`,
      );
    }
    state.set(oid, { u, commit: await readCommit(repo, oid), popped: false, order: order++ });
    enqueue(oid);
    return true;
  };

  const haveTips: string[] = [];
  const roots: ToSend[] = [];
  for (const h of haves) {
    const tags: string[] = [];
    const p = await peel(repo, h, tags);
    for (const t of tags) uninterestingObjects.add(t);
    if (!p) continue; // a have we do not have
    if (p.type === "commit") {
      if (await visit(p.oid, true)) haveTips.push(p.oid);
    } else if (p.type === "tree") roots.push(p);
    else uninterestingObjects.add(p.oid);
  }
  const wantTags: string[] = [];
  const wantRoots: ToSend[] = [];
  for (const w of wants) {
    const tags: string[] = [];
    const p = await peel(repo, w, tags);
    if (!p) throw new Error(`want ${w} is missing from this repository`);
    wantTags.push(...tags);
    if (p.type === "commit") await visit(p.oid, false);
    else wantRoots.push(p);
  }
  const result: string[] = [];
  let slop = SLOP;
  while (queue.length) {
    signal?.throwIfAborted();
    // Stop when only uninteresting commits are queued AND none of them is as new as an
    // interesting commit found so far: a queued commit could still reach that one only through
    // older commits (git's cut-off relies on commit dates; with equal dates it keeps walking, which
    // the random-history test showed is needed). SLOP more commits cover clock skew.
    if (queue.every((q) => (state.get(q) as State).u)) {
      const newestQueued = (state.get(queue[0] as string) as State).commit.committer.when;
      let oldestInteresting = Number.POSITIVE_INFINITY;
      for (const r of result) {
        const rs = state.get(r) as State;
        if (!rs.u) oldestInteresting = Math.min(oldestInteresting, rs.commit.committer.when);
      }
      if (newestQueued < oldestInteresting && --slop < 0) break;
    } else slop = SLOP;
    const c = queue.shift() as string;
    const s = state.get(c) as State;
    s.popped = true;
    if (!s.u) result.push(c);
    if (shallow.has(c)) continue;
    for (const p of s.commit.parents) await visit(p, s.u);
  }
  const commits = result.filter((c) => !(state.get(c) as State).u);
  const edges: string[] = [];
  const edgeSet = new Set<string>();
  for (const c of commits) {
    if (shallow.has(c)) continue;
    for (const p of (state.get(c) as State).commit.parents) {
      const ps = state.get(p);
      if (ps?.u && !edgeSet.has(p)) {
        edgeSet.add(p);
        edges.push(p);
      }
    }
  }

  // --- trees and blobs
  const markTree = async (tree: string) => {
    if (uninterestingObjects.has(tree)) return;
    signal?.throwIfAborted();
    uninterestingObjects.add(tree);
    for (const e of await readTree(repo, tree)) {
      if (Number.parseInt(e.mode, 8) === 0o160000) continue;
      if (isTreeMode(e.mode)) await markTree(e.oid);
      else uninterestingObjects.add(e.oid);
    }
  };
  for (const r of roots) await markTree(r.oid); // trees given as haves
  for (const c of [...haveTips, ...edges]) {
    const s = state.get(c);
    await markTree((s ? s.commit : await readCommit(repo, c)).tree);
  }
  for (const t of wantTags) if (!uninterestingObjects.has(t)) add({ oid: t, type: "tag" });
  for (const c of commits) add({ oid: c, type: "commit" });
  const walkTree = async (tree: string, path: string) => {
    if (uninterestingObjects.has(tree)) return;
    if (!add(path ? { oid: tree, type: "tree", path } : { oid: tree, type: "tree" })) return;
    signal?.throwIfAborted();
    for (const e of await readTree(repo, tree)) {
      if (Number.parseInt(e.mode, 8) === 0o160000) continue; // a gitlink: another repository's commit
      const p = path ? `${path}/${e.name}` : e.name;
      if (isTreeMode(e.mode)) await walkTree(e.oid, p);
      else if (!uninterestingObjects.has(e.oid)) add({ oid: e.oid, type: "blob", path: p });
    }
  };
  for (const c of commits) await walkTree((state.get(c) as State).commit.tree, "");
  for (const r of wantRoots) {
    if (r.type === "tree") await walkTree(r.oid, "");
    else if (!uninterestingObjects.has(r.oid)) add(r);
  }
  return { objects: out, edges };
}

export async function listObjects(
  repo: Repository,
  wants: string[],
  haves: string[],
  opts: WalkOptions = {},
): Promise<ToSend[]> {
  return (await listObjectsWithEdges(repo, wants, haves, opts)).objects;
}

function entryHeader(type: ObjectType, size: number): Uint8Array {
  const out: number[] = [];
  let b = (TYPE_CODE[type] << 4) | (size & 15);
  let s = Math.floor(size / 16);
  while (s) {
    out.push(b | 0x80);
    b = s & 127;
    s = Math.floor(s / 128);
  }
  out.push(b);
  return Uint8Array.from(out);
}

export async function* writePack(
  repo: Repository,
  objects: ToSend[],
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<Uint8Array> {
  const hash = sha1.create();
  const emit = (b: Uint8Array) => {
    hash.update(b);
    return b;
  };
  const head = new Uint8Array(12);
  head.set([0x50, 0x41, 0x43, 0x4b]); // "PACK"
  const v = new DataView(head.buffer);
  v.setUint32(4, 2);
  v.setUint32(8, objects.length);
  opts.signal?.throwIfAborted();
  yield emit(head);
  // an object opened but not yet iterated (the consumer may leave right after its entry header):
  // released in `finally`; once iteration starts, for-await releases it
  let unstarted: AsyncIterable<Uint8Array> | undefined;
  try {
    for (const { oid, type } of objects) {
      opts.signal?.throwIfAborted();
      const o = await repo.objects.get(oid);
      if (!o) throw new Error(`object ${oid} is not in this repository`);
      if (o.type !== type) {
        await o.content[Symbol.asyncIterator]().return?.();
        throw new Error(`object ${oid} is a ${o.type}, listed as a ${type}`);
      }
      unstarted = o.content;
      yield emit(entryHeader(o.type, o.size));
      unstarted = undefined;
      const pending: Uint8Array[] = [];
      const d = new Deflate();
      d.onData = (c: Uint8Array) => {
        pending.push(c);
      };
      let got = 0;
      // for-await releases the object's stream when the consumer leaves early (return, throw)
      for await (const c of o.content) {
        opts.signal?.throwIfAborted();
        got += c.length;
        d.push(c, false);
        while (pending.length) yield emit(pending.shift() as Uint8Array);
      }
      if (got !== o.size) throw new Error(`object ${oid}: ${got} bytes read, ${o.size} declared`);
      d.push(new Uint8Array(0), true);
      if (d.err) throw new Error(`deflate failed: ${d.msg}`);
      while (pending.length) yield emit(pending.shift() as Uint8Array);
    }
  } finally {
    if (unstarted) await unstarted[Symbol.asyncIterator]().return?.();
  }
  yield hash.digest();
}

export async function* exportPack(
  repo: Repository,
  wants: string[],
  haves: string[],
  opts: WalkOptions = {},
): AsyncGenerator<Uint8Array> {
  const objects = await listObjects(repo, wants, haves, opts);
  yield* writePack(repo, objects, opts);
}
