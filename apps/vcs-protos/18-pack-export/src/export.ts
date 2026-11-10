/**
 * X6c — pack export over X16a's Repository (git files or SQL).
 *
 * `listObjects` walks as `git rev-list --objects <wants> --not <haves>`: commits reachable from
 * the wants and not from the haves (full ancestry; a missing parent is a shallow boundary); then
 * each such commit's tree, recursively, minus the trees and blobs reachable from the trees of the
 * haves (mark_tree_uninteresting on the negative tips) and of the edges — uninteresting parents of
 * listed commits (rev-list's mark_edges_uninteresting) — and minus what was already listed.
 * Annotated tags among the wants are listed with what they point at; gitlinks (160000) are not
 * objects of this repository.
 *
 * `writePack` writes them as a version-2 pack of whole objects, pulled by the consumer: an
 * object is opened only when the consumer asks for the bytes after the previous one, its content
 * streams through a deflater (memory: a deflate window, not the object), the pack's SHA-1 runs
 * over the output, and an AbortSignal is checked between chunks. Leaving the generator early
 * (return, throw, abort) releases the open object's stream.
 */
import { sha1 } from "@noble/hashes/legacy.js";
import { Deflate } from "pako";
import { readCommit, readTree } from "../../17-repository/src/commands.js";
import { isTreeMode, parseTagTarget } from "../../17-repository/src/git-format.js";
import type { ObjectType, Repository } from "../../17-repository/src/object-store.js";

export interface ToSend {
  oid: string;
  type: ObjectType;
}

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

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

/** Follows tags; returns the tags passed and the object they end at. */
async function peel(repo: Repository, oid: string, tags: ToSend[]): Promise<ToSend | undefined> {
  for (let i = 0; i < 16; i++) {
    const t = await typeOf(repo, oid);
    if (!t) return undefined;
    if (t.type !== "tag") return { oid, type: t.type };
    tags.push({ oid, type: "tag" });
    oid = parseTagTarget(t.bytes as Uint8Array).object;
  }
  throw new Error(`tag chain too long at ${oid}`);
}

export async function listObjects(
  repo: Repository,
  wants: string[],
  haves: string[],
): Promise<ToSend[]> {
  const out: ToSend[] = [];
  const seen = new Set<string>();
  const add = (o: ToSend) => {
    if (seen.has(o.oid)) return false;
    seen.add(o.oid);
    out.push(o);
    return true;
  };
  // uninteresting: every commit reachable from the haves; the trees/blobs of the haves' trees
  const uninteresting = new Set<string>();
  const haveTips: string[] = [];
  for (const h of haves) {
    const p = await peel(repo, h, []);
    if (p?.type === "commit") haveTips.push(p.oid);
  }
  const stack = [...haveTips];
  while (stack.length) {
    const c = stack.pop() as string;
    if (uninteresting.has(c) || !(await repo.objects.has(c))) continue;
    uninteresting.add(c);
    stack.push(...(await readCommit(repo, c)).parents);
  }
  const markTree = async (tree: string) => {
    if (uninteresting.has(tree)) return;
    uninteresting.add(tree);
    for (const e of await readTree(repo, tree)) {
      if (Number.parseInt(e.mode, 8) === 0o160000) continue;
      if (isTreeMode(e.mode)) await markTree(e.oid);
      else uninteresting.add(e.oid);
    }
  };
  for (const c of haveTips) await markTree((await readCommit(repo, c)).tree);

  // interesting commits, then their trees
  const commits: string[] = [];
  const roots: ToSend[] = [];
  for (const w of wants) {
    const tags: ToSend[] = [];
    const p = await peel(repo, w, tags);
    for (const t of tags) if (!uninteresting.has(t.oid)) add(t);
    if (!p) throw new Error(`want ${w} is not in this repository`);
    if (p.type === "commit") commits.push(p.oid);
    else roots.push(p);
  }
  const queue = [...commits];
  const visited = new Set<string>();
  const trees: string[] = [];
  const edges = new Set<string>();
  while (queue.length) {
    const c = queue.shift() as string;
    if (visited.has(c) || uninteresting.has(c)) continue;
    visited.add(c);
    if (!(await repo.objects.has(c))) continue; // shallow boundary
    const commit = await readCommit(repo, c);
    add({ oid: c, type: "commit" });
    trees.push(commit.tree);
    for (const p of commit.parents) {
      if (uninteresting.has(p)) edges.add(p);
      else queue.push(p);
    }
  }
  // git's mark_edges_uninteresting: the trees of the uninteresting parents of interesting commits
  // (a side branch forked below a have) are not sent either
  for (const e of edges) await markTree((await readCommit(repo, e)).tree);
  const walkTree = async (tree: string) => {
    if (uninteresting.has(tree) || !add({ oid: tree, type: "tree" })) return;
    for (const e of await readTree(repo, tree)) {
      if (Number.parseInt(e.mode, 8) === 0o160000) continue; // a gitlink: another repository's commit
      if (isTreeMode(e.mode)) await walkTree(e.oid);
      else if (!uninteresting.has(e.oid)) add({ oid: e.oid, type: "blob" });
    }
  };
  for (const t of trees) await walkTree(t);
  for (const r of roots) {
    if (r.type === "tree") await walkTree(r.oid);
    else if (!uninteresting.has(r.oid)) add(r);
  }
  return out;
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
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<Uint8Array> {
  const objects = await listObjects(repo, wants, haves);
  yield* writePack(repo, objects, opts);
}
