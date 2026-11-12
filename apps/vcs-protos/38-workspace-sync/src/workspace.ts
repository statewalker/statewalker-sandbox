/**
 * X17 — folders kept in step through git history. Each endpoint records its folder as commits on
 * `refs/heads/main` of its own repository; a sync commits both folders, copies the missing objects
 * each way, and merges (X13f's recursive merge). Merges are deterministic — parents in id order, a
 * fixed identity, the later parent's date, labels from the parent ids — so two endpoints merging the
 * same heads make the same commit, and syncs converge on one commit, not only one tree. Conflicts
 * are committed with git's markers and reported, so they converge too.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { createSha1, toHex } from "../../01-streaming-git-hash/src/git-object-hash.js";
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
/** the commit the folder was last checked out at (git's index, reduced to its tree) */
const CHECKED_OUT = "/sync/checked-out";
const dec = new TextDecoder();

export async function openEndpoint(o: {
  name: string;
  folder: FilesApi;
  storage: FilesApi;
  now: () => number;
}): Promise<Endpoint> {
  const repo = await filesRepository(o.storage, filesRefFiles(o.storage));
  if (!(await repo.refs.read("HEAD"))) await repo.refs.setSymref("HEAD", MAIN);
  const ep = { ...o, repo };
  if (!(await checkedOut(ep))) {
    const head = await headOf(ep);
    if (head) await setCheckedOut(ep, head);
  }
  return ep;
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

async function checkedOut(ep: Endpoint): Promise<string | undefined> {
  if (!(await ep.storage.exists(CHECKED_OUT))) return undefined;
  return dec.decode(await readAll(ep.storage, CHECKED_OUT)).trim() || undefined;
}
async function setCheckedOut(ep: Endpoint, oid: string) {
  await ep.storage.write(CHECKED_OUT, [new TextEncoder().encode(`${oid}\n`)]);
}

/**
 * Records the folder as a commit when it differs from HEAD's tree; returns the head. A checkout
 * left unfinished (a crash after the ref moved) is finished first, so a half-written folder is
 * never taken for local edits.
 */
export async function commitFolder(ep: Endpoint): Promise<string | undefined> {
  const at = await checkedOut(ep);
  const current = await headOf(ep);
  if (current && at !== current) {
    const kept = await checkout(ep, at, current);
    if (kept.size && at) await keepUserEdits(ep, at, kept);
  }
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
  // The folder is this commit now. Left at the old record, a later checkout (a head moved by a
  // push, X17b) would take this commit's own edits for the user's and keep them over the merge.
  await setCheckedOut(ep, oid);
  return oid;
}

/**
 * Copies the objects reachable from `oid` that `to` lacks, children before parents: a commit is
 * stored only once its tree, blobs and parents are, so "a commit present has its history" holds
 * even after a transfer that failed halfway.
 */
async function transfer(from: Repository, to: Repository, oid: string): Promise<void> {
  const stack: [string, boolean][] = [[oid, false]];
  const seen = new Set<string>();
  while (stack.length) {
    const [id, expanded] = stack.pop() as [string, boolean];
    if (expanded) {
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
      await to.objects.put(o.type, bytes);
      continue;
    }
    if (seen.has(id) || (await to.objects.has(id))) continue;
    seen.add(id);
    stack.push([id, true]);
    const o = await from.objects.get(id);
    if (!o) throw new Error(`no object ${id}`);
    const type = o.type;
    await o.content[Symbol.asyncIterator]().return?.();
    if (type === "commit") {
      const c = await readCommit(from, id);
      for (const child of [c.tree, ...c.parents]) stack.push([child, false]);
    } else if (type === "tree")
      for (const e of await readTree(from, id)) stack.push([e.oid, false]);
  }
}

const blobId = (data: Uint8Array) =>
  toHex(
    createSha1("noble")
      .update(new TextEncoder().encode(`blob ${data.length}\0`))
      .update(data)
      .digest(),
  );

async function removeEmptyParents(folder: FilesApi, path: string) {
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const dir = `/${path.slice(0, i)}`;
    if ((await folder.stats(dir))?.kind !== "directory") continue;
    for await (const _ of folder.list(dir)) return;
    await folder.remove(dir);
  }
}

/**
 * Moves the folder from `from`'s files to `to`'s. A path is changed only where the folder still
 * holds `from`'s version (or already holds `to`'s, or `alsoOld`'s): a path the user changed
 * meanwhile keeps the user's bytes. Then the folder is recorded as checked out at `to`. Run again
 * after a failure, it finishes what is left.
 *
 * Returns the user's bytes kept on paths `to` also changed (or deleted): edits the user made
 * against `from` that `to` knows nothing of. Committed on top of `to` they would silently replace
 * `to`'s changes, so the caller merges them instead (`keepUserEdits`).
 */
async function checkout(
  ep: Endpoint,
  from: string | undefined,
  to: string,
  alsoOld: Map<string, string> = new Map(),
): Promise<Map<string, Uint8Array>> {
  const before = from ? await flatten(ep.repo, (await readCommit(ep.repo, from)).tree) : new Map();
  const after = await flatten(ep.repo, (await readCommit(ep.repo, to)).tree);
  const kept = new Map<string, Uint8Array>();
  const current = async (p: string) =>
    (await ep.folder.stats(`/${p}`))?.kind === "file"
      ? blobId(await readAll(ep.folder, `/${p}`))
      : undefined;
  const isOld = (p: string, now: string | undefined) =>
    now === before.get(p) || (now !== undefined && now === alsoOld.get(p));
  for (const [p, oid] of before)
    if (!after.has(p)) {
      const now = await current(p);
      if (now === oid || (now !== undefined && now === alsoOld.get(p))) {
        await ep.folder.remove(`/${p}`);
        await removeEmptyParents(ep.folder, p);
      } else if (now !== undefined) kept.set(p, await readAll(ep.folder, `/${p}`)); // edited, deleted by `to`
    }
  for (const [p, oid] of after) {
    const now = await current(p);
    if (now === oid) continue;
    if (now !== undefined && !isOld(p, now)) {
      // the user's edit: kept, and reported when `to` changed this path too
      if (before.get(p) !== oid && from) kept.set(p, await readAll(ep.folder, `/${p}`));
      continue;
    }
    const st = await ep.folder.stats(`/${p}`);
    if (st?.kind === "directory") {
      let empty = true;
      for await (const _ of ep.folder.list(`/${p}`)) {
        empty = false;
        break;
      }
      if (!empty) continue; // the user's files there: kept
      await ep.folder.remove(`/${p}`);
    }
    await ep.folder.write(`/${p}`, [await blob(ep.repo, oid)]);
  }
  await setCheckedOut(ep, to);
  return kept;
}

/**
 * The user's edits a checkout had to keep over `to`'s changes, made against `from`: committed on
 * top of `from` (so the base is what the user saw) and merged into the head, so both sides survive
 * — merged where they touch different lines, with git's conflict markers where they collide.
 */
async function keepUserEdits(
  ep: Endpoint,
  from: string,
  kept: Map<string, Uint8Array>,
): Promise<string[]> {
  const files = new Map<string, Uint8Array>();
  for (const [p, oid] of await flatten(ep.repo, (await readCommit(ep.repo, from)).tree))
    files.set(p, await blob(ep.repo, oid));
  for (const [p, bytes] of kept) files.set(p, bytes);
  const tree = await writeFiles(ep.repo, Object.fromEntries(files));
  const me: Person = { name: ep.name, email: `${ep.name}@sync.local`, when: ep.now(), tz: "+0000" };
  const user = await ep.repo.objects.put(
    "commit",
    encodeCommit({
      tree,
      parents: [from],
      author: me,
      committer: me,
      message: `${ep.name}: folder changes\n`,
    }),
  );
  const alsoOld = new Map([...kept].map(([p, bytes]) => [p, blobId(bytes)]));
  return mergeInto(ep, user, alsoOld);
}

/** merges `theirs` into the endpoint's head: nothing, a fast-forward, or a deterministic merge */
export async function mergeInto(
  ep: Endpoint,
  theirs: string,
  alsoOld: Map<string, string> = new Map(),
): Promise<string[]> {
  const ours = await headOf(ep);
  if (ours === theirs) return [];
  const extra: string[] = [];
  const update = async (to: string) => {
    const r = await ep.repo.refs.batch([{ name: MAIN, old: ours ?? null, new: to }]);
    if (!r.ok) throw new Error(`${ep.name}: ${MAIN} moved`);
    const kept = await checkout(ep, ours, to, alsoOld);
    if (kept.size && ours) extra.push(...(await keepUserEdits(ep, ours, kept)));
  };
  if (!ours) {
    await update(theirs);
    return extra;
  }
  const bases = await mergeBases(ep.repo, ours, theirs);
  if (bases.includes(theirs)) return [];
  if (bases.includes(ours)) {
    await update(theirs);
    return extra;
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
  return [...new Set([...conflicts, ...extra])].sort();
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
  await commitFolder(a);
  const theirs = await commitFolder(b);
  let conflicts: string[] = [];
  if (theirs) {
    await transfer(b.repo, a.repo, theirs);
    conflicts = await mergeInto(a, theirs);
  }
  const head = (await headOf(a)) as string;
  if (!o.oneWay && head) {
    await transfer(a.repo, b.repo, head);
    for (const c of await mergeInto(b, head)) if (!conflicts.includes(c)) conflicts.push(c);
  }
  return { head, conflicts };
}
