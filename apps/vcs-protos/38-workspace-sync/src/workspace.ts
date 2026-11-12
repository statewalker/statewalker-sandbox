/**
 * X17 — folders kept in step through git history. Each endpoint records its folder as commits on
 * `refs/heads/main` of its own repository; a sync commits both folders, copies the missing objects
 * each way, and merges (X13f's recursive merge). Merges are deterministic — parents in id order, a
 * fixed identity, the later parent's date, labels from the parent ids — so two endpoints merging the
 * same heads make the same commit, and syncs converge on one commit, not only one tree. Conflicts
 * are committed with git's markers and reported, so they converge too.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { commit, readCommit, readTree, writeFiles } from "../../17-repository/src/commands.js";
import { encodeCommit, type Person } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import { mergeBases, mergeCommits } from "../../33-criss-cross/src/recursive.js";
import { filesRefFiles } from "../../35-sequencer/src/files-adapters.js";

export interface Endpoint {
  name: string;
  /** the folder kept in step */
  folder: FilesApi;
  /** where the endpoint's repository lives (laid out as a `.git` directory) */
  storage: FilesApi;
  repo: Repository;
  /** seconds, for local commits */
  now: () => number;
}

const MAIN = "refs/heads/main";
const dec = new TextDecoder();

export async function openEndpoint(o: {
  name: string;
  folder: FilesApi;
  storage: FilesApi;
  now: () => number;
}): Promise<Endpoint> {
  const repo = await filesRepository(o.storage, filesRefFiles(o.storage));
  if (!(await repo.refs.read("HEAD"))) await repo.refs.setSymref("HEAD", MAIN);
  return { ...o, repo };
}

export async function headOf(ep: Endpoint): Promise<string | undefined> {
  return ep.repo.refs.resolve(MAIN);
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of files.read(path)) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
async function folderBytes(folder: FilesApi): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for await (const e of folder.list("/", { recursive: true }))
    if (e.kind === "file") out.set(e.path.replace(/^\//, ""), await readAll(folder, e.path));
  return out;
}

/** the folder's files as text (for comparing endpoints) */
export async function folderFiles(ep: Endpoint): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [p, b] of [...(await folderBytes(ep.folder))].sort(([a], [b]) => (a < b ? -1 : 1)))
    out[p] = dec.decode(b);
  return out;
}

async function blob(repo: Repository, oid: string): Promise<Uint8Array> {
  const o = await repo.objects.get(oid);
  if (!o) throw new Error(`no object ${oid}`);
  const parts: Uint8Array[] = [];
  for await (const p of o.content) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
async function flatten(
  repo: Repository,
  tree: string,
  prefix = "",
  out = new Map<string, string>(),
) {
  for (const e of await readTree(repo, tree)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (Number.parseInt(e.mode, 8) === 0o40000) await flatten(repo, e.oid, path, out);
    else out.set(path, e.oid);
  }
  return out;
}

/** records the folder as a commit when it differs from HEAD's tree */
async function snapshot(ep: Endpoint): Promise<string | undefined> {
  const head = await headOf(ep);
  const files = await folderBytes(ep.folder);
  const tree = await writeFiles(ep.repo, Object.fromEntries(files));
  if (head && (await readCommit(ep.repo, head)).tree === tree) return head;
  if (!head && files.size === 0) return undefined;
  const when = ep.now();
  const me: Person = { name: ep.name, email: `${ep.name}@sync.local`, when, tz: "+0000" };
  const { oid, result } = await commit(ep.repo, {
    ref: MAIN,
    tree,
    parents: head ? [head] : [],
    author: me,
    committer: me,
    message: `${ep.name}: folder changes\n`,
    expected: head ?? null,
  });
  if (!result.ok) throw new Error(`${ep.name}: ${MAIN} moved`);
  return oid;
}

/** copies the objects reachable from `oid` that `to` lacks (a commit present has its history) */
async function transfer(from: Repository, to: Repository, oid: string): Promise<void> {
  const stack = [oid];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id) || (await to.objects.has(id))) continue;
    seen.add(id);
    const o = await from.objects.get(id);
    if (!o) throw new Error(`no object ${id}`);
    const parts: Uint8Array[] = [];
    for await (const p of o.content) parts.push(p);
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    if (o.type === "commit") {
      const c = await readCommit(from, id);
      stack.push(c.tree, ...c.parents);
    } else if (o.type === "tree") for (const e of await readTree(from, id)) stack.push(e.oid);
    await to.objects.put(o.type, bytes);
  }
}

/** makes the folder hold `to`'s files (it held `from`'s) */
async function checkout(ep: Endpoint, from: string | undefined, to: string) {
  const before = from ? await flatten(ep.repo, (await readCommit(ep.repo, from)).tree) : new Map();
  const after = await flatten(ep.repo, (await readCommit(ep.repo, to)).tree);
  for (const p of before.keys()) if (!after.has(p)) await ep.folder.remove(`/${p}`);
  for (const [p, oid] of after) {
    if (before.get(p) === oid) continue;
    if ((await ep.folder.stats(`/${p}`))?.kind === "directory") await ep.folder.remove(`/${p}`);
    await ep.folder.write(`/${p}`, [await blob(ep.repo, oid)]);
  }
}

/** merges `theirs` into the endpoint's head: nothing, a fast-forward, or a deterministic merge */
async function mergeInto(ep: Endpoint, theirs: string): Promise<string[]> {
  const ours = await headOf(ep);
  if (ours === theirs) return [];
  const update = async (to: string) => {
    const r = await ep.repo.refs.batch([{ name: MAIN, old: ours ?? null, new: to }]);
    if (!r.ok) throw new Error(`${ep.name}: ${MAIN} moved`);
    await checkout(ep, ours, to);
  };
  if (!ours) {
    await update(theirs);
    return [];
  }
  const bases = await mergeBases(ep.repo, ours, theirs);
  if (bases.includes(theirs)) return [];
  if (bases.includes(ours)) {
    await update(theirs);
    return [];
  }
  const [p1, p2] = [ours, theirs].sort() as [string, string];
  const r = await mergeCommits(ep.repo, p1, p2, {
    ours: p1.slice(0, 12),
    theirs: p2.slice(0, 12),
    allowUnrelated: true,
  });
  const when = Math.max(
    (await readCommit(ep.repo, p1)).committer.when,
    (await readCommit(ep.repo, p2)).committer.when,
  );
  const sync: Person = { name: "sync", email: "sync@sync.local", when, tz: "+0000" };
  const conflicts = [...new Set(r.conflicts.map((c) => c.path))].sort();
  const message = conflicts.length
    ? `Merge with conflicts\n\n${conflicts.map((p) => `conflict: ${p}`).join("\n")}\n`
    : "Merge\n";
  // the commit object alone: MAIN moves through `update`, with its compare-and-swap
  const oid = await ep.repo.objects.put(
    "commit",
    encodeCommit({ tree: r.tree, parents: [p1, p2], author: sync, committer: sync, message }),
  );
  await update(oid);
  return conflicts;
}

/**
 * Syncs two endpoints: both folders are committed, `a` takes `b`'s commits and merges them, then
 * (unless `oneWay`) `b` takes `a`'s result, a fast-forward.
 */
export async function sync(
  a: Endpoint,
  b: Endpoint,
  o: { oneWay?: boolean } = {},
): Promise<{ head: string; conflicts: string[] }> {
  await snapshot(a);
  const theirs = await snapshot(b);
  let conflicts: string[] = [];
  if (theirs) {
    await transfer(b.repo, a.repo, theirs);
    conflicts = await mergeInto(a, theirs);
  }
  const head = (await headOf(a)) as string;
  if (!o.oneWay && head) {
    await transfer(a.repo, b.repo, head);
    await mergeInto(b, head);
  }
  return { head, conflicts };
}
