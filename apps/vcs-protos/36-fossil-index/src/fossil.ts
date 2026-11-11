/**
 * X9 — Fossil-like history queries from SQL tables kept with the repository.
 *
 * Three tables, written in the same transaction as the ref update that makes the commits reachable
 * (X5's `sqlRefDb` `beforeCommit` hook):
 * - `fossil_commit`: each indexed commit once — committer date, whether it is a merge, its message;
 * - `fossil_change`: for each non-merge commit, the file paths that differ from its parent (all of
 *   them for a root commit): adds, edits, deletes, mode changes, a file that became a directory;
 * - `fossil_text`: an FTS5 trigram index of the messages (case-sensitive, as `git log --grep`).
 *
 * `pathHistory(path)` is `git log --all --no-merges -- <path>` (the path as a file or a directory)
 * and `searchMessages(text)` is `git log --all --no-merges -F --grep=<text>`, newest first. The
 * same answers come from walking the objects (`walkPathHistory`, `walkSearch`).
 */

import type { Db } from "@statewalker/db-api";
import type { RefDb } from "../../10-ref-transactions/src/ref-db.js";
import { sqlRefDb } from "../../10-ref-transactions/src/sql-ref-db.js";
import { readCommit, readTree } from "../../17-repository/src/commands.js";
import type { ObjectStore, Repository } from "../../17-repository/src/object-store.js";
import { sqlRepository } from "../../17-repository/src/sql-repository.js";

export interface FossilIndex {
  /**
   * The rows of the commits reachable from `tips` that are not indexed yet. Reads objects, so it
   * runs outside the ref transaction (a SQL object store shares the transaction's database).
   */
  prepare(tips: string[]): Promise<IndexRows>;
  /** writes prepared rows through `tx`, skipping commits indexed since they were prepared */
  write(tx: Db, rows: IndexRows): Promise<void>;
  /** `prepare` then `write`, for a store outside the index's database */
  indexCommits(tx: Db, tips: string[]): Promise<void>;
  pathHistory(path: string): Promise<string[]>;
  searchMessages(text: string): Promise<string[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fossil_commit (
     oid TEXT PRIMARY KEY, date INTEGER NOT NULL, merge INTEGER NOT NULL, message TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS fossil_commit_date ON fossil_commit (date)",
  `CREATE TABLE IF NOT EXISTS fossil_change (
     path TEXT NOT NULL, oid TEXT NOT NULL, PRIMARY KEY (path, oid)) WITHOUT ROWID`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS fossil_text USING fts5(
     oid UNINDEXED, message, tokenize = 'trigram case_sensitive 1')`,
];

// ---------------------------------------------------------------- tree differences

type Repo = Pick<Repository, "objects">;

/** a few hundred parsed trees: a commit's parent tree is the previous commit's tree */
function treeReader(objects: ObjectStore) {
  const cache = new Map<string, { name: string; mode: string; oid: string }[]>();
  return async (oid: string) => {
    let t = cache.get(oid);
    if (t) {
      cache.delete(oid);
      cache.set(oid, t);
      return t;
    }
    t = await readTree({ objects } as Repository, oid);
    cache.set(oid, t);
    if (cache.size > 512) cache.delete(cache.keys().next().value as string);
    return t;
  };
}
const isTree = (mode: string) => Number.parseInt(mode, 8) === 0o40000;

/** the file paths that differ between two trees (either may be absent) */
async function changedPaths(
  read: ReturnType<typeof treeReader>,
  a: string | undefined,
  b: string | undefined,
  prefix: string,
  out: string[],
): Promise<void> {
  if (a === b) return;
  const left = new Map((a ? await read(a) : []).map((e) => [e.name, e]));
  const right = new Map((b ? await read(b) : []).map((e) => [e.name, e]));
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(name);
    const y = right.get(name);
    if (x && y && x.oid === y.oid && x.mode === y.mode) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const xt = x && isTree(x.mode);
    const yt = y && isTree(y.mode);
    if (x && !xt) out.push(path);
    else if (y && !yt && !(x && !xt)) out.push(path);
    if (xt || yt)
      await changedPaths(read, xt ? x.oid : undefined, yt ? y.oid : undefined, path, out);
  }
}

export type IndexRows = CommitInfo[];
interface CommitInfo {
  oid: string;
  date: number;
  merge: boolean;
  message: string;
  changes: string[];
}

/** walks the commits reachable from `tips`, stopping at those `known` says are done */
async function* commitsFrom(
  repo: Repo,
  tips: string[],
  known: (oid: string) => Promise<boolean>,
): AsyncGenerator<CommitInfo> {
  const read = treeReader(repo.objects);
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (await known(oid)) continue;
    const c = await readCommit(repo as Repository, oid);
    const merge = c.parents.length > 1;
    const changes: string[] = [];
    if (!merge) {
      const parentTree = c.parents[0]
        ? (await readCommit(repo as Repository, c.parents[0])).tree
        : undefined;
      await changedPaths(read, parentTree, c.tree, "", changes);
    }
    yield { oid, date: c.committer.when, merge, message: c.message, changes };
    stack.push(...c.parents);
  }
}

// ---------------------------------------------------------------- the index

async function insertRows(tx: Db, rows: CommitInfo[]) {
  if (!rows.length) return;
  await tx.query(
    `INSERT INTO fossil_commit (oid, date, merge, message) VALUES ${rows.map(() => "(?, ?, ?, ?)").join(", ")}`,
    rows.flatMap((c) => [c.oid, c.date, c.merge ? 1 : 0, c.message]),
  );
  await tx.query(
    `INSERT INTO fossil_text (oid, message) VALUES ${rows.map(() => "(?, ?)").join(", ")}`,
    rows.flatMap((c) => [c.oid, c.message]),
  );
  const changes = rows.flatMap((c) => c.changes.map((p) => [p, c.oid]));
  for (let i = 0; i < changes.length; i += 400) {
    const part = changes.slice(i, i + 400);
    await tx.query(
      `INSERT OR IGNORE INTO fossil_change (path, oid) VALUES ${part.map(() => "(?, ?)").join(", ")}`,
      part.flat(),
    );
  }
}

const SPAN = (path: string) => [path, `${path}/`, `${path}0`]; // '0' follows '/'

export async function fossilIndex(
  db: Db,
  objects: ObjectStore,
  opts: { failAfter?: number } = {},
): Promise<FossilIndex> {
  for (const s of SCHEMA) await db.exec(s);
  const repo: Repo = { objects };
  const index: FossilIndex = {
    async prepare(tips) {
      const out: CommitInfo[] = [];
      const known = async (oid: string) =>
        (await db.query("SELECT 1 FROM fossil_commit WHERE oid = ?", [oid])).length > 0;
      for await (const c of commitsFrom(repo, tips, known)) out.push(c);
      return out;
    },
    async write(tx, prepared) {
      const fresh: CommitInfo[] = [];
      for (const c of prepared)
        if (!(await tx.query("SELECT 1 FROM fossil_commit WHERE oid = ?", [c.oid])).length)
          fresh.push(c);
      for (let i = 0; i < fresh.length; i += 200) {
        if (opts.failAfter !== undefined && i + 200 > opts.failAfter)
          throw new Error("fossil: indexing failed (test hook)");
        await insertRows(tx, fresh.slice(i, i + 200));
      }
      if (opts.failAfter !== undefined && fresh.length > opts.failAfter)
        throw new Error("fossil: indexing failed (test hook)");
    },
    async indexCommits(tx, tips) {
      await index.write(tx, await index.prepare(tips));
    },
    async pathHistory(path) {
      const [exact, lo, hi] = SPAN(path);
      const rows = await db.query<{ oid: string }>(
        `SELECT c.oid FROM fossil_commit c
           WHERE c.merge = 0 AND c.oid IN (
             SELECT oid FROM fossil_change WHERE path = ? OR (path >= ? AND path < ?))
           ORDER BY c.date DESC`,
        [exact, lo, hi],
      );
      return rows.map((r) => r.oid);
    },
    async searchMessages(text) {
      const rows =
        text.length >= 3
          ? await db.query<{ oid: string }>(
              `SELECT c.oid FROM fossil_commit c
                 WHERE c.merge = 0 AND instr(c.message, ?) > 0 AND c.oid IN (
                   SELECT oid FROM fossil_text WHERE fossil_text MATCH ?)
                 ORDER BY c.date DESC`,
              [text, `"${text.replace(/"/g, '""')}"`],
            )
          : await db.query<{ oid: string }>(
              `SELECT oid FROM fossil_commit WHERE merge = 0 AND instr(message, ?) > 0
                 ORDER BY date DESC`,
              [text],
            );
      return rows.map((r) => r.oid);
    },
  };
  return index;
}

/**
 * X16a's `sqlRepository` whose ref batches index the commits they make reachable: the rows are
 * prepared before the batch (reading objects) and written by the batch's `beforeCommit` hook, in
 * its transaction. Batches go through one at a time, so each hook writes its own batch's rows.
 */
export async function indexedSqlRepository(
  db: Db,
  opts: { failAfter?: number } = {},
): Promise<{ repo: Repository; index: FossilIndex }> {
  const base = await sqlRepository(db);
  const index = await fossilIndex(db, base.objects, opts);
  let pending: IndexRows = [];
  const inner = await sqlRefDb(db, "refdb_", {
    beforeCommit: (tx) => index.write(tx, pending),
  });
  let queue: Promise<unknown> = Promise.resolve();
  const refs: RefDb = {
    ...inner,
    batch(commands, o) {
      const run = queue.then(async () => {
        pending = await index.prepare(commands.flatMap((c) => (c.new ? [c.new] : [])));
        try {
          return await inner.batch(commands, o);
        } finally {
          pending = [];
        }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  return { repo: { objects: base.objects, refs }, index };
}

// ---------------------------------------------------------------- without the index

async function allCommits(repo: Repository): Promise<CommitInfo[]> {
  const tips: string[] = [];
  for await (const r of repo.refs.list("refs/")) tips.push(r.oid);
  const head = await repo.refs.resolve("HEAD");
  if (head) tips.push(head);
  const out: CommitInfo[] = [];
  for await (const c of commitsFrom(repo, tips, async () => false)) out.push(c);
  return out.sort((a, b) => b.date - a.date);
}

/** `git log --all --no-merges -- <path>` by walking the objects */
export async function walkPathHistory(repo: Repository, path: string): Promise<string[]> {
  const under = `${path}/`;
  return (await allCommits(repo))
    .filter((c) => !c.merge && c.changes.some((p) => p === path || p.startsWith(under)))
    .map((c) => c.oid);
}

/** `git log --all --no-merges -F --grep=<text>` by walking the objects */
export async function walkSearch(repo: Repository, text: string): Promise<string[]> {
  return (await allCommits(repo))
    .filter((c) => !c.merge && c.message.includes(text))
    .map((c) => c.oid);
}
