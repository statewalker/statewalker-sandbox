/**
 * The command layer: depends on the ObjectStore and RefDb interfaces and git's formats only (R4).
 */
import type { BatchResult } from "../../10-ref-transactions/src/ref-db.js";
import {
  type CommitData,
  encodeCommit,
  encodeTree,
  type Person,
  parseCommit,
  parseTree,
  type TreeEntry,
} from "./git-format.js";
import type { Repository } from "./repository.js";

async function bytesOf(repo: Repository, oid: string, type: string): Promise<Uint8Array> {
  const o = await repo.objects.get(oid);
  if (!o) throw new Error(`no object ${oid}`);
  if (o.type !== type) throw new Error(`${oid} is a ${o.type}, not a ${type}`);
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of o.content) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let p = 0;
  for (const c of parts) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export async function writeBlob(repo: Repository, bytes: Uint8Array): Promise<string> {
  return repo.objects.put("blob", bytes);
}

export async function writeTree(repo: Repository, entries: TreeEntry[]): Promise<string> {
  return repo.objects.put("tree", encodeTree(entries));
}

/** Writes nested trees for a { "dir/file": bytes } map; returns the root tree id. */
export async function writeFiles(
  repo: Repository,
  files: Record<string, Uint8Array>,
): Promise<string> {
  type Dir = Map<string, Dir | Uint8Array>;
  const root: Dir = new Map();
  for (const [path, bytes] of Object.entries(files)) {
    const parts = path.split("/");
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      let next = dir.get(p);
      if (!next) {
        next = new Map();
        dir.set(p, next);
      }
      if (next instanceof Uint8Array) throw new Error(`${path}: ${p} is a file`);
      dir = next;
    }
    dir.set(parts[parts.length - 1] as string, bytes);
  }
  const write = async (dir: Dir): Promise<string> => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of dir) {
      if (v instanceof Uint8Array)
        entries.push({ mode: "100644", name, oid: await writeBlob(repo, v) });
      else entries.push({ mode: "40000", name, oid: await write(v) });
    }
    return writeTree(repo, entries);
  };
  return write(root);
}

export async function readTree(repo: Repository, oid: string): Promise<TreeEntry[]> {
  return parseTree(await bytesOf(repo, oid, "tree"));
}

export async function readCommit(repo: Repository, oid: string): Promise<CommitData> {
  return parseCommit(await bytesOf(repo, oid, "commit"));
}

/**
 * Writes a commit and moves `ref` to it with compare-and-swap: `expected` is the ref's current
 * value (default: the first parent, or "must not exist" for a root commit).
 */
export async function commit(
  repo: Repository,
  opts: {
    ref: string;
    tree: string;
    parents?: string[];
    author: Person;
    committer?: Person;
    message: string;
    expected?: string | null;
  },
): Promise<{ oid: string; result: BatchResult }> {
  const parents = opts.parents ?? [];
  const oid = await repo.objects.put(
    "commit",
    encodeCommit({
      tree: opts.tree,
      parents,
      author: opts.author,
      committer: opts.committer ?? opts.author,
      message: opts.message,
    }),
  );
  const old = opts.expected !== undefined ? opts.expected : (parents[0] ?? null);
  const result = await repo.refs.batch([{ name: opts.ref, old, new: oid }]);
  return { oid, result };
}

/**
 * `git log`: commits reachable from `ref` (a ref name or an id), newest committer date first;
 * equal dates in the order they were reached (git's commit-date priority queue).
 */
export async function log(
  repo: Repository,
  ref: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const start = /^[0-9a-f]{40}$/.test(ref) ? ref : await repo.refs.resolve(ref);
  if (!start) return [];
  const out: string[] = [];
  const seen = new Set<string>([start]);
  let order = 0;
  type Item = { oid: string; when: number; order: number };
  const queue: Item[] = [];
  const push = async (oid: string) => {
    const c = await readCommit(repo, oid);
    queue.push({ oid, when: c.committer.when, order: order++ });
    queue.sort((a, b) => b.when - a.when || a.order - b.order);
    return c;
  };
  await push(start);
  while (queue.length && out.length < limit) {
    const item = queue.shift() as Item;
    out.push(item.oid);
    const c = await readCommit(repo, item.oid);
    for (const p of c.parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      await push(p);
    }
  }
  return out;
}

export async function receivePack(
  repo: Repository,
  pack: AsyncIterable<Uint8Array>,
): Promise<{ packId: string; count: number }> {
  return repo.objects.installPack(pack);
}
