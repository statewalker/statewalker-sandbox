/**
 * X9 — Fossil-like history queries from SQL tables kept with the repository.
 *
 * Three tables, written in the same transaction as the ref update that makes the commits reachable
 * (X5's `sqlRefDb` `beforeCommit` hook):
 * - `fossil_commit`: each indexed commit once — committer date, whether it is a merge, its message;
 * - `fossil_change`: for each non-merge commit, the file paths that differ from its parent (all of
 *   them for a root commit): adds, edits, deletes, mode changes, a file that became a directory;
 * - `fossil_text`: an FTS5 trigram index of the messages (case-sensitive, as `git log --grep`);
 * - `fossil_parent`, `fossil_merge_change` (X9b): every commit's parents, and for each merge the
 *   paths that differ from each parent, for git's default history simplification.
 *
 * `pathHistory(path)` is `git log --all --full-history --no-merges -- <path>`; `simplifiedPathHistory`
 * (X9b) is the same without `--full-history`, from given tips (a literal path, as a
 * file or a directory) and `searchMessages(text)` is `git log --all --no-merges -F --grep=<text>`.
 * Both list newest first, by committer date and then by id: git's order wherever dates are distinct
 * and fall from child to parent. The same answers come from walking the objects
 * (`walkPathHistory`, `walkSearch`). Refs to annotated tags are peeled; refs to other objects are
 * skipped, as `git log --all` does.
 */

import type { Db } from "@statewalker/db-api";
import type { RefDb } from "../../10-ref-transactions/src/ref-db.js";
import { sqlRefDb } from "../../10-ref-transactions/src/sql-ref-db.js";
import { readCommit, readTree } from "../../17-repository/src/commands.js";
import { parseTagTarget } from "../../17-repository/src/git-format.js";
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
  /**
   * `git log --no-merges -- <path>` from `tips` (for `--all`: every ref and HEAD), with git's
   * default history simplification: a merge that is TREESAME to a parent for the path (no
   * difference under it) is followed through its first such parent only, so commits that only a
   * discarded side of a merge reaches are not listed.
   */
  simplifiedPathHistory(path: string, tips: string[]): Promise<string[]>;
  searchMessages(text: string): Promise<string[]>;
}

const SCHEMA = [
  // `parents` (X9b): how many parents the commit has; NULL in an index written before X9b
  `CREATE TABLE IF NOT EXISTS fossil_commit (
     oid TEXT PRIMARY KEY, date INTEGER NOT NULL, merge INTEGER NOT NULL, message TEXT NOT NULL,
     parents INTEGER)`,
  "CREATE INDEX IF NOT EXISTS fossil_commit_date ON fossil_commit (date)",
  `CREATE TABLE IF NOT EXISTS fossil_change (
     path TEXT NOT NULL, oid TEXT NOT NULL, PRIMARY KEY (path, oid)) WITHOUT ROWID`,
  // every commit's parents, in order, with their count (the walk of simplifiedPathHistory)
  `CREATE TABLE IF NOT EXISTS fossil_parent (
     oid TEXT NOT NULL, idx INTEGER NOT NULL, parent TEXT NOT NULL, n INTEGER NOT NULL,
     PRIMARY KEY (oid, idx)) WITHOUT ROWID`,
  // for each merge, the file paths that differ from its parent number idx (TREESAME tests)
  `CREATE TABLE IF NOT EXISTS fossil_merge_change (
     oid TEXT NOT NULL, idx INTEGER NOT NULL, path TEXT NOT NULL,
     PRIMARY KEY (oid, idx, path)) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS fossil_merge_change_path ON fossil_merge_change (path)",
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
    if (cache.size > 4096) cache.delete(cache.keys().next().value as string);
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
  // keyed by the name's bytes: two names that are not UTF-8 may decode alike
  const key = (e: { name: string; nameBytes?: Uint8Array }) =>
    e.nameBytes ? `\0${Array.from(e.nameBytes).join(",")}` : e.name;
  const left = new Map((a ? await read(a) : []).map((e) => [key(e), e]));
  const right = new Map((b ? await read(b) : []).map((e) => [key(e), e]));
  for (const k of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(k);
    const y = right.get(k);
    if (x && y && x.oid === y.oid && x.mode === y.mode) continue;
    const name = (x ?? y)?.name as string;
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
/** one commit's rows: its date, whether it is a merge, its message, the paths it changed */
export interface CommitInfo {
  oid: string;
  date: number;
  merge: boolean;
  message: string;
  changes: string[];
  parents: string[];
  /** for a merge, per parent, the paths that differ from it */
  mergeChanges: string[][];
}

/** walks the commits reachable from `tips`, stopping at those `known` says are done */
async function* commitsFrom(
  repo: Repo,
  tips: string[],
  known: (oid: string) => Promise<boolean>,
): AsyncGenerator<CommitInfo> {
  const read = treeReader(repo.objects);
  // each commit is read once: its tree is kept for the child that diffs against it
  const trees = new Map<string, string>();
  const treeOf = async (oid: string) => {
    let t = trees.get(oid);
    if (t === undefined) {
      t = (await readCommit(repo as Repository, oid)).tree;
      trees.set(oid, t);
    }
    return t;
  };
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const t of tips) {
    const c = await peelToCommit(repo, t);
    if (c) stack.push(c);
  }
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (await known(oid)) continue;
    const c = await readCommit(repo as Repository, oid);
    trees.set(oid, c.tree);
    const merge = c.parents.length > 1;
    const changes: string[] = [];
    const mergeChanges: string[][] = [];
    if (!merge) {
      const parentTree = c.parents[0] ? await treeOf(c.parents[0]) : undefined;
      await changedPaths(read, parentTree, c.tree, "", changes);
    } else
      for (const p of c.parents) {
        const diff: string[] = [];
        await changedPaths(read, await treeOf(p), c.tree, "", diff);
        mergeChanges.push(diff);
      }
    yield {
      oid,
      date: c.committer.when,
      merge,
      message: c.message,
      changes,
      parents: c.parents,
      mergeChanges,
    };
    stack.push(...c.parents);
  }
}

/** a ref's commit: annotated tags followed, anything else (a blob, a tree) none */
async function peelToCommit(repo: Repo, oid: string): Promise<string | undefined> {
  for (let i = 0; i < 16; i++) {
    const o = await repo.objects.get(oid);
    if (!o) return undefined;
    if (o.type === "commit") {
      await o.content[Symbol.asyncIterator]().return?.();
      return oid;
    }
    if (o.type !== "tag") {
      await o.content[Symbol.asyncIterator]().return?.();
      return undefined;
    }
    const parts: Uint8Array[] = [];
    for await (const c of o.content) parts.push(c);
    const bytes = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of parts) {
      bytes.set(c, at);
      at += c.length;
    }
    oid = parseTagTarget(bytes).object;
  }
  return undefined;
}

/**
 * A pathspec as git reads it, for literal paths: `./` and a trailing `/` or `/.` dropped, `.` the
 * whole tree (""). Glob characters and `:(magic)` are refused rather than matched literally (git's
 * `--literal-pathspecs` would read them as names); so is an empty pathspec, which git rejects.
 */
export function literalPath(pathspec: string): string {
  if (pathspec === "") throw new Error("empty pathspec");
  if (/[*?[\\]/.test(pathspec) || pathspec.startsWith(":"))
    throw new Error(`${pathspec}: pathspec magic and globs are not supported (literal paths only)`);
  let p = pathspec;
  while (p.startsWith("./")) p = p.slice(2);
  if (p === ".") p = "";
  while (p.endsWith("/.")) p = p.slice(0, -2);
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p === "." ? "" : p;
}

/** newest first by committer date, then by id: one order for the index and the walk */
const byOrder = (a: { date: number; oid: string }, b: { date: number; oid: string }) =>
  b.date - a.date || (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0);

// ---------------------------------------------------------------- the index

async function insertRows(tx: Db, rows: CommitInfo[]) {
  if (!rows.length) return;
  await insertGraphRows(tx, rows);
  const changes = rows.flatMap((c) => c.changes.map((p) => [p, c.oid]));
  for (let i = 0; i < changes.length; i += 400) {
    const part = changes.slice(i, i + 400);
    await tx.query(
      `INSERT OR IGNORE INTO fossil_change (path, oid) VALUES ${part.map(() => "(?, ?)").join(", ")}`,
      part.flat(),
    );
  }
  await tx.query(
    `INSERT INTO fossil_text (oid, message) VALUES ${rows.map(() => "(?, ?)").join(", ")}`,
    rows.flatMap((c) => [c.oid, c.message]),
  );
  // the commit rows last: a query on the same connection mid-write (inside this transaction) sees
  // a commit only once its parents and differences are there (review of #119)
  await tx.query(
    `INSERT INTO fossil_commit (oid, date, merge, message, parents) VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    rows.flatMap((c) => [c.oid, c.date, c.merge ? 1 : 0, c.message, c.parents.length]),
  );
}

/** a commit's parents and, for a merge, its differences from each: what the walk reads */
async function insertGraphRows(tx: Db, rows: CommitInfo[]) {
  const parents = rows.flatMap((c) => c.parents.map((p, i) => [c.oid, i, p, c.parents.length]));
  for (let i = 0; i < parents.length; i += 200) {
    const part = parents.slice(i, i + 200);
    await tx.query(
      `INSERT OR IGNORE INTO fossil_parent (oid, idx, parent, n) VALUES ${part.map(() => "(?, ?, ?, ?)").join(", ")}`,
      part.flat(),
    );
  }
  const mergeChanges = rows.flatMap((c) =>
    c.mergeChanges.flatMap((paths, i) => paths.map((p) => [c.oid, i, p])),
  );
  for (let i = 0; i < mergeChanges.length; i += 300) {
    const part = mergeChanges.slice(i, i + 300);
    await tx.query(
      `INSERT OR IGNORE INTO fossil_merge_change (oid, idx, path) VALUES ${part.map(() => "(?, ?, ?)").join(", ")}`,
      part.flat(),
    );
  }
}

const EMPTY_INFO: CommitInfo = {
  oid: "",
  date: 0,
  merge: false,
  message: "",
  changes: [],
  parents: [],
  mergeChanges: [],
};

/** does `p` fall under the literal path `path` ("" is the whole tree) */
const under = (path: string, p: string) => path === "" || p === path || p.startsWith(`${path}/`);

const SPAN = (path: string) => [path, `${path}/`, `${path}0`]; // '0' follows '/'

/**
 * The indexed commits' parents in memory, by integer id, for walks: loaded once, then extended by
 * the rows added since (a rowid watermark on `fossil_commit`, whose rows are only ever inserted).
 * A commit is cached only once all its parent rows are seen (their count is the commit row's
 * `parents`); one it lacks is read from the tables when the walk reaches it, so the cache only
 * ever saves queries and never changes an answer.
 */
function parentGraph(db: Db) {
  const ids = new Map<string, number>();
  const oids: string[] = [];
  /** parents by id; undefined: not loaded (or not complete) yet */
  const parents: (number[] | undefined)[] = [];
  let watermark = 0;
  const idOf = (oid: string): number => {
    let id = ids.get(oid);
    if (id === undefined) {
      id = oids.length;
      ids.set(oid, id);
      oids.push(oid);
      parents.push(undefined);
    }
    return id;
  };
  type ParentRow = { oid: string; idx: number; parent: string };
  /** caches the commits whose parent rows are all here */
  const take = (commits: { oid: string; parents: number | null }[], rows: ParentRow[]) => {
    const found = new Map<string, string[]>();
    for (const r of rows) {
      const list = found.get(r.oid) ?? [];
      list[Number(r.idx)] = r.parent;
      found.set(r.oid, list);
    }
    for (const c of commits) {
      if (c.parents === null || c.parents === undefined) continue; // written before X9b
      const list = found.get(c.oid) ?? [];
      if (list.length !== Number(c.parents) || list.includes(undefined as never)) continue;
      parents[idOf(c.oid)] = list.map(idOf);
    }
  };
  const load = async (list: string[]) => {
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      const marks = part.map(() => "?").join(", ");
      // the commit rows first: written last, so their parents are there when they are
      const commits = await db.query<{ oid: string; parents: number | null }>(
        `SELECT oid, parents FROM fossil_commit WHERE oid IN (${marks})`,
        part,
      );
      const rows = await db.query<ParentRow>(
        `SELECT oid, idx, parent FROM fossil_parent WHERE oid IN (${marks})`,
        part,
      );
      take(commits, rows);
    }
  };
  return {
    oids,
    idOf,
    lookup: (oid: string) => ids.get(oid),
    /** takes in the rows added since the last call */
    async refresh(): Promise<void> {
      const fresh = await db.query<{ rowid: number; oid: string; parents: number | null }>(
        "SELECT rowid, oid, parents FROM fossil_commit WHERE rowid > ? ORDER BY rowid",
        [watermark],
      );
      if (!fresh.length) return;
      watermark = Number(fresh[fresh.length - 1]?.rowid);
      if (fresh.length > 1000)
        // the whole table at once rather than in IN-lists
        take(fresh, await db.query<ParentRow>("SELECT oid, idx, parent FROM fossil_parent"));
      else await load(fresh.map((f) => f.oid));
    },
    /** the parents already in memory, without a query */
    cached: (id: number) => parents[id],
    /** the parents of an indexed commit; one not indexed (or not complete) is refused */
    async parentsOf(id: number): Promise<number[]> {
      if (!parents[id]) await load([oids[id] as string]);
      const list = parents[id];
      if (!list) throw new Error(`fossil: commit ${oids[id]} is not indexed`);
      return list;
    },
  };
}

export async function fossilIndex(
  db: Db,
  objects: ObjectStore,
  opts: { failAfter?: number } = {},
): Promise<FossilIndex> {
  for (const s of SCHEMA) await db.exec(s);
  // an index written before X9b has no `parents` column
  const columns = await db.query<{ name: string }>("PRAGMA table_info(fossil_commit)");
  if (!columns.some((c) => c.name === "parents"))
    await db.exec("ALTER TABLE fossil_commit ADD COLUMN parents INTEGER");
  const repo: Repo = { objects };
  const graph = parentGraph(db);
  /**
   * The parents and merge differences of commits indexed before X9b (`parents` NULL), read from
   * the objects once per handle: without them every such commit would read as a root and every
   * merge as TREESAME to its first parent (review of #119).
   */
  let backfilled = false;
  const backfillOnce = async () => {
    if (backfilled) return;
    const read = treeReader(objects);
    for (;;) {
      const old = await db.query<{ oid: string }>(
        "SELECT oid FROM fossil_commit WHERE parents IS NULL LIMIT 200",
      );
      if (!old.length) break;
      const infos: CommitInfo[] = [];
      for (const { oid } of old) {
        const c = await readCommit(repo as Repository, oid);
        const mergeChanges: string[][] = [];
        if (c.parents.length > 1)
          for (const p of c.parents) {
            const diff: string[] = [];
            await changedPaths(
              read,
              (await readCommit(repo as Repository, p)).tree,
              c.tree,
              "",
              diff,
            );
            mergeChanges.push(diff);
          }
        infos.push({ ...EMPTY_INFO, oid, parents: c.parents, mergeChanges });
      }
      await insertGraphRows(db, infos);
      for (const i of infos)
        await db.query("UPDATE fossil_commit SET parents = ? WHERE oid = ?", [
          i.parents.length,
          i.oid,
        ]);
    }
    backfilled = true;
  };
  /**
   * The tips as commits: indexed commits as they are, annotated tags peeled, other objects (a
   * blob, a tree) skipped as `git log --all` does; an id that is no object here is refused.
   */
  const commitTips = async (tips: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const t of tips) {
      if ((await db.query("SELECT 1 FROM fossil_commit WHERE oid = ?", [t])).length) {
        out.push(t);
        continue;
      }
      if (!(await objects.has(t))) throw new Error(`fossil: tip ${t} is not indexed`);
      const c = await peelToCommit(repo, t);
      if (c) out.push(c);
    }
    return out;
  };
  const index: FossilIndex = {
    async prepare(tips) {
      const out: CommitInfo[] = [];
      // an empty index knows nothing: no query per commit
      const empty = (await db.query("SELECT 1 FROM fossil_commit LIMIT 1")).length === 0;
      const known = async (oid: string) =>
        !empty && (await db.query("SELECT 1 FROM fossil_commit WHERE oid = ?", [oid])).length > 0;
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
    async pathHistory(pathspec) {
      const path = literalPath(pathspec);
      const rows = path
        ? await db.query<{ oid: string }>(
            `SELECT c.oid FROM fossil_commit c
               WHERE c.merge = 0 AND c.oid IN (
                 SELECT oid FROM fossil_change WHERE path = ? OR (path >= ? AND path < ?))
               ORDER BY c.date DESC, c.oid`,
            SPAN(path),
          )
        : await db.query<{ oid: string }>(
            `SELECT c.oid FROM fossil_commit c
               WHERE c.merge = 0 AND c.oid IN (SELECT oid FROM fossil_change)
               ORDER BY c.date DESC, c.oid`,
          );
      return rows.map((r) => r.oid);
    },
    async simplifiedPathHistory(pathspec, tips) {
      const path = literalPath(pathspec);
      await backfillOnce();
      // before the differences are read: a commit cached here had its differences written first
      await graph.refresh();
      // the merges' parents that differ from the merge under `path`: one indexed range
      const rows = path
        ? await db.query<{ oid: string; idx: number }>(
            "SELECT oid, idx FROM fossil_merge_change WHERE path = ? OR (path >= ? AND path < ?)",
            SPAN(path),
          )
        : await db.query<{ oid: string; idx: number }>(
            "SELECT DISTINCT oid, idx FROM fossil_merge_change",
          );
      const differs = new Map<number, Set<number>>();
      for (const r of rows) {
        const id = graph.idOf(r.oid);
        const set = differs.get(id) ?? new Set<number>();
        set.add(Number(r.idx));
        differs.set(id, set);
      }
      // walk from the tips: every parent of a non-merge; of a merge, its first parent TREESAME
      // for the path if it has one (git's try_to_simplify_commit), else all of them
      const stack: number[] = [];
      for (const t of await commitTips(tips)) stack.push(graph.idOf(t));
      let seen = new Uint8Array(graph.oids.length + stack.length);
      while (stack.length) {
        const id = stack.pop() as number;
        if (id >= seen.length) {
          const grown = new Uint8Array(Math.max(id + 1, seen.length * 2));
          grown.set(seen);
          seen = grown;
        }
        if (seen[id]) continue;
        seen[id] = 1;
        const parents = graph.cached(id) ?? (await graph.parentsOf(id));
        if (parents.length < 2) {
          for (const p of parents) stack.push(p);
        } else {
          const diff = differs.get(id);
          const same = parents.findIndex((_, i) => !diff?.has(i));
          if (same >= 0) stack.push(parents[same] as number);
          else for (const p of parents) stack.push(p);
        }
      }
      return (await index.pathHistory(pathspec)).filter((oid) => {
        const id = graph.lookup(oid);
        return id !== undefined && seen[id] === 1;
      });
    },
    async searchMessages(text) {
      // git splits the pattern into lines, any of which may match; an empty line matches all
      const parts = [...new Set(text.split("\n"))];
      if (parts.includes(""))
        return (
          await db.query<{ oid: string }>(
            "SELECT oid FROM fossil_commit WHERE merge = 0 ORDER BY date DESC, oid",
          )
        ).map((r) => r.oid);
      const found = new Map<string, { oid: string; date: number }>();
      for (const part of parts) {
        const rows =
          [...part].length >= 3 // trigrams are of characters, not UTF-16 units
            ? await db.query<{ oid: string; date: number }>(
                `SELECT c.oid, c.date FROM fossil_commit c
                   WHERE c.merge = 0 AND instr(c.message, ?) > 0 AND c.oid IN (
                     SELECT oid FROM fossil_text WHERE fossil_text MATCH ?)`,
                [part, `"${part.replace(/"/g, '""')}"`],
              )
            : await db.query<{ oid: string; date: number }>(
                "SELECT oid, date FROM fossil_commit WHERE merge = 0 AND instr(message, ?) > 0",
                [part],
              );
        for (const r of rows) found.set(r.oid, { oid: r.oid, date: Number(r.date) });
      }
      return [...found.values()].sort(byOrder).map((r) => r.oid);
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
  return out.sort(byOrder);
}

/** `git log --all --full-history --no-merges -- <path>` by walking the objects */
export async function walkPathHistory(repo: Repository, pathspec: string): Promise<string[]> {
  const path = literalPath(pathspec);
  const under = `${path}/`;
  return (await allCommits(repo))
    .filter(
      (c) => !c.merge && c.changes.some((p) => path === "" || p === path || p.startsWith(under)),
    )
    .map((c) => c.oid);
}

/** `git log --all --no-merges -- <path>` (git's default simplification) by walking the objects */
export async function walkSimplifiedPathHistory(
  repo: Repository,
  pathspec: string,
): Promise<string[]> {
  const path = literalPath(pathspec);
  const all = new Map((await allCommits(repo)).map((c) => [c.oid, c]));
  const tips: string[] = [];
  for await (const r of repo.refs.list("refs/")) tips.push(r.oid);
  const head = await repo.refs.resolve("HEAD");
  if (head) tips.push(head);
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const t of tips) {
    const c = await peelToCommit(repo, t);
    if (c) stack.push(c);
  }
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = all.get(oid) as CommitInfo;
    if (!c.merge) stack.push(...c.parents);
    else {
      const same = c.mergeChanges.findIndex((diff) => !diff.some((p) => under(path, p)));
      stack.push(...(same >= 0 ? [c.parents[same] as string] : c.parents));
    }
  }
  return [...all.values()]
    .filter((c) => seen.has(c.oid) && !c.merge && c.changes.some((p) => under(path, p)))
    .map((c) => c.oid);
}

/** `git log --all --no-merges -F --grep=<text>` by walking the objects */
export async function walkSearch(repo: Repository, text: string): Promise<string[]> {
  const parts = text.split("\n");
  return (await allCommits(repo))
    .filter((c) => !c.merge && parts.some((part) => c.message.includes(part)))
    .map((c) => c.oid);
}
