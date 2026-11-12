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
/**
 * User edits a checkout kept over paths the new head also changed, until they are merged:
 * `{ base, paths }`, the commit the user worked from and the paths. Written before the checkout
 * is recorded and removed once the merge holding them is in, so a merge that loses its race, or
 * a crash, leaves them to be merged by the next `commitFolder` rather than forgotten.
 */
const KEPT = "/sync/kept-edits";
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
  return (await commitFolderReport(ep)).head;
}

/**
 * `commitFolder`, also naming the paths committed with conflict markers on the way: a checkout
 * that kept the user's edits over a moved head merges them first (X17b's refresh after a push).
 */
export async function commitFolderReport(
  ep: Endpoint,
): Promise<{ head: string | undefined; conflicts: string[] }> {
  const at = await checkedOut(ep);
  const current = await headOf(ep);
  if (current && at !== current) await checkout(ep, at, current);
  const conflicts = await finishKeptEdits(ep);
  const head = await headOf(ep);
  const files = await folderBytes(ep.folder);
  const tree = await writeFiles(ep.repo, Object.fromEntries(files));
  if (head && (await readCommit(ep.repo, head)).tree === tree) return { head, conflicts };
  if (!head && files.size === 0) return { head: undefined, conflicts };
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
  if (!result.ok)
    // what was merged on the way is committed already: the error carries it for the retry
    throw Object.assign(new Error(`${ep.name}: ${MAIN} moved`), { conflicts });
  // The folder is this commit now. Left at the old record, a later checkout (a head moved by a
  // push, X17b) would take this commit's own edits for the user's and keep them over the merge.
  await setCheckedOut(ep, oid);
  return { head: oid, conflicts };
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
  if (kept.size && from) {
    const pending = await readKept(ep);
    await writeKept(ep, {
      base: pending?.base ?? from,
      paths: [...new Set([...(pending?.paths ?? []), ...kept.keys()])].sort(),
    });
  }
  await setCheckedOut(ep, to);
  return kept;
}

interface KeptEdits {
  base: string;
  paths: string[];
}
async function readKept(ep: Endpoint): Promise<KeptEdits | undefined> {
  if (!(await ep.storage.exists(KEPT))) return undefined;
  return JSON.parse(dec.decode(await readAll(ep.storage, KEPT))) as KeptEdits;
}
async function writeKept(ep: Endpoint, kept: KeptEdits): Promise<void> {
  await ep.storage.write(KEPT, [new TextEncoder().encode(JSON.stringify(kept))]);
}
const finishing = new WeakSet<Endpoint>();
/**
 * Merges the kept user edits recorded in `KEPT`, if any: their current bytes in the folder
 * (a path the user has since deleted is deleted) are committed on the commit the user worked
 * from, and that commit is merged into the head. A merge that loses its race throws and leaves
 * the record for the next call. Not re-entered: the merge's own checkout only adds to the record,
 * and the loop here merges what it added.
 */
async function finishKeptEdits(ep: Endpoint): Promise<string[]> {
  if (finishing.has(ep)) return [];
  finishing.add(ep);
  try {
    const conflicts: string[] = [];
    for (let round = 0; round < 8; round++) {
      const pending = await readKept(ep);
      if (!pending) return conflicts;
      const files = new Map<string, Uint8Array>();
      for (const [p, oid] of await flatten(ep.repo, (await readCommit(ep.repo, pending.base)).tree))
        files.set(p, await blob(ep.repo, oid));
      const alsoOld = new Map<string, string>();
      for (const p of pending.paths) {
        if ((await ep.folder.stats(`/${p}`))?.kind === "file") {
          const bytes = await readAll(ep.folder, `/${p}`);
          files.set(p, bytes);
          alsoOld.set(p, blobId(bytes));
        } else files.delete(p);
      }
      const tree = await writeFiles(ep.repo, Object.fromEntries(files));
      const me: Person = {
        name: ep.name,
        email: `${ep.name}@sync.local`,
        when: ep.now(),
        tz: "+0000",
      };
      const user = await ep.repo.objects.put(
        "commit",
        encodeCommit({
          tree,
          parents: [pending.base],
          author: me,
          committer: me,
          message: `${ep.name}: folder changes\n`,
        }),
      );
      const before = JSON.stringify(pending);
      conflicts.push(...(await mergeInto(ep, user, alsoOld)));
      // the merge's checkout may have kept more (an edit typed meanwhile): merge that next
      const after = await readKept(ep);
      if (after && JSON.stringify(after) === before) await ep.storage.remove(KEPT);
      else if (after) {
        const rest = after.paths.filter((p) => !pending.paths.includes(p));
        // their base stays the older one: at worst a spurious conflict, never an edit lost
        if (rest.length) await writeKept(ep, { base: after.base, paths: rest });
        else await ep.storage.remove(KEPT);
      }
    }
    throw new Error(`${ep.name}: kept edits did not settle`);
  } finally {
    finishing.delete(ep);
  }
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
    // from what the folder holds, which is not `ours` when a push moved `main` meanwhile:
    // `ours`' changes are then not in the folder yet, and must not be taken for the user's
    await checkout(ep, (await checkedOut(ep)) ?? ours, to, alsoOld);
    extra.push(...(await finishKeptEdits(ep)));
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
  const ca = await commitFolderReport(a);
  const cb = await commitFolderReport(b);
  const theirs = cb.head;
  const conflicts = [...new Set([...ca.conflicts, ...cb.conflicts])];
  if (theirs) {
    await transfer(b.repo, a.repo, theirs);
    for (const c of await mergeInto(a, theirs)) if (!conflicts.includes(c)) conflicts.push(c);
  }
  const head = (await headOf(a)) as string;
  if (!o.oneWay && head) {
    await transfer(a.repo, b.repo, head);
    for (const c of await mergeInto(b, head)) if (!conflicts.includes(c)) conflicts.push(c);
  }
  return { head, conflicts: conflicts.sort() };
}
