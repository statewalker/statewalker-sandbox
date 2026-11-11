/**
 * X13f — merge-ort's recursive merge (`merge_ort_internal`) over commits: git's merge bases
 * (`get_merge_bases`, commit-reach.c, walked by commit date as without a commit-graph), merged
 * pairwise into virtual merge bases ("Temporary merge branch 1/2", one level deeper each time),
 * then the outer merge.
 */

import { readCommit } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import type { TreeMergeOptions, TreeMergeResult } from "../../29-merge/src/merge-trees.js";
import { mergeOrt } from "../../31-ort/src/ort.js";

/** a commit as the walk sees it: real (with an id, parsed on first visit) or virtual */
interface Node {
  id?: string;
  parsed: boolean;
  tree: string;
  date: number;
  parents: Node[];
  flags: number;
}

const PARENT1 = 1;
const PARENT2 = 2;
const STALE = 4;
const RESULT = 8;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** the commits of a repository, each parsed when a walk first reaches it (repo_parse_commit) */
class Graph {
  private nodes = new Map<string, Node>();
  constructor(readonly repo: Repository) {}

  node(id: string): Node {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, parsed: false, tree: "", date: 0, parents: [], flags: 0 };
      this.nodes.set(id, n);
    }
    return n;
  }

  async parse(n: Node): Promise<Node> {
    if (n.parsed) return n;
    const c = await readCommit(this.repo, n.id as string);
    n.tree = c.tree;
    n.date = c.committer.when;
    n.parents = c.parents.map((p) => this.node(p));
    n.parsed = true;
    return n;
  }
}
const graphs = new WeakMap<Repository, Graph>();
function graphOf(repo: Repository): Graph {
  let g = graphs.get(repo);
  if (!g) {
    g = new Graph(repo);
    graphs.set(repo, g);
  }
  return g;
}

/** git's prio_queue of commits: newest date first, then insertion order */
class Queue {
  private items: { n: Node; ctr: number }[] = [];
  private ctr = 0;
  put(n: Node) {
    this.items.push({ n, ctr: this.ctr++ });
  }
  get size() {
    return this.items.length;
  }
  get(): Node {
    let best = 0;
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i] as { n: Node; ctr: number };
      const b = this.items[best] as { n: Node; ctr: number };
      if (a.n.date > b.n.date || (a.n.date === b.n.date && a.ctr < b.ctr)) best = i;
    }
    return (this.items.splice(best, 1)[0] as { n: Node }).n;
  }
  hasNonStale() {
    return this.items.some((x) => !(x.n.flags & STALE));
  }
}

/** commit_list_insert_by_date: before the first strictly older commit */
function insertByDate(list: Node[], n: Node) {
  const at = list.findIndex((x) => x.date < n.date);
  if (at < 0) list.push(n);
  else list.splice(at, 0, n);
}

function clearMarks(starts: Node[]) {
  const stack = [...starts];
  while (stack.length) {
    const n = stack.pop() as Node;
    if (!n.flags) continue;
    n.flags = 0;
    stack.push(...n.parents);
  }
}

/** paint_down_to_common */
async function paintDownToCommon(g: Graph, one: Node, twos: Node[]): Promise<Node[]> {
  const queue = new Queue();
  const result: Node[] = [];
  one.flags |= PARENT1;
  if (!twos.length) return [one];
  queue.put(one);
  for (const t of twos) {
    t.flags |= PARENT2;
    queue.put(t);
  }
  while (queue.hasNonStale()) {
    const c = queue.get();
    let flags = c.flags & (PARENT1 | PARENT2 | STALE);
    if (flags === (PARENT1 | PARENT2)) {
      if (!(c.flags & RESULT)) {
        c.flags |= RESULT;
        insertByDate(result, c);
      }
      flags |= STALE;
    }
    for (const p of c.parents) {
      if ((p.flags & flags) === flags) continue;
      await g.parse(p);
      p.flags |= flags;
      queue.put(p);
    }
  }
  return result;
}

/** merge_bases_many */
async function mergeBasesMany(g: Graph, one: Node, twos: Node[]): Promise<Node[]> {
  if (twos.includes(one)) return [one];
  const list = await paintDownToCommon(g, one, twos);
  const result: Node[] = [];
  for (const c of list) if (!(c.flags & STALE)) insertByDate(result, c);
  return result;
}

/** remove_redundant_no_gen: drop candidates that are ancestors of other candidates */
async function removeRedundant(g: Graph, array: Node[]): Promise<Node[]> {
  const redundant = array.map(() => false);
  for (let i = 0; i < array.length; i++) {
    if (redundant[i]) continue;
    const work: Node[] = [];
    const index: number[] = [];
    for (let j = 0; j < array.length; j++) {
      if (i === j || redundant[j]) continue;
      index.push(j);
      work.push(array[j] as Node);
    }
    const ai = array[i] as Node;
    await paintDownToCommon(g, ai, work);
    if (ai.flags & PARENT2) redundant[i] = true;
    work.forEach((w, k) => {
      if (w.flags & PARENT1) redundant[index[k] as number] = true;
    });
    clearMarks([ai, ...work]);
  }
  return array.filter((_, i) => !redundant[i]);
}

/** get_merge_bases_many_0 for two commits */
async function getMergeBases(g: Graph, one: Node, two: Node): Promise<Node[]> {
  const result = await mergeBasesMany(g, one, [two]);
  if (one === two) return result;
  if (result.length < 2) {
    clearMarks([one, two]);
    return result;
  }
  clearMarks([one, two]);
  const kept = await removeRedundant(g, result);
  const out: Node[] = [];
  for (const c of kept) insertByDate(out, c);
  return out;
}

/** `git merge-base --all a b`, in git's order */
export async function mergeBases(repo: Repository, a: string, b: string): Promise<string[]> {
  const g = graphOf(repo);
  const bases = await getMergeBases(g, await g.parse(g.node(a)), await g.parse(g.node(b)));
  return bases.map((n) => n.id as string);
}

/** merge_ort_internal */
async function mergeOrtInternal(
  g: Graph,
  repo: Repository,
  bases: Node[] | undefined,
  h1: Node,
  h2: Node,
  opts: TreeMergeOptions,
  depth: number,
): Promise<TreeMergeResult> {
  const list = bases ?? (await getMergeBases(g, h1, h2)).reverse();
  // no common ancestor: a virtual one with the empty tree
  if (!list.length) await repo.objects.put("tree", new Uint8Array(0));
  let merged: Node = list.shift() ?? {
    parsed: true,
    tree: EMPTY_TREE,
    date: 0,
    parents: [],
    flags: 0,
  };
  for (let next = list.shift(); next; next = list.shift()) {
    const prev = merged;
    const inner = await mergeOrtInternal(
      g,
      repo,
      undefined,
      prev,
      next,
      { ...opts, ours: "Temporary merge branch 1", theirs: "Temporary merge branch 2" },
      depth + 1,
    );
    merged = { parsed: true, tree: inner.tree, date: 0, parents: [prev, next], flags: 0 };
  }
  return mergeOrt(repo, merged.tree, h1.tree, h2.tree, opts, depth);
}

/** `git merge-tree --write-tree ours theirs`: recursive over their merge bases */
export async function mergeCommits(
  repo: Repository,
  ours: string,
  theirs: string,
  opts: TreeMergeOptions & { allowUnrelated?: boolean },
): Promise<TreeMergeResult> {
  const g = graphOf(repo);
  const h1 = await g.parse(g.node(ours));
  const h2 = await g.parse(g.node(theirs));
  const bases = await getMergeBases(g, h1, h2);
  if (!bases.length && !opts.allowUnrelated)
    throw new Error("refusing to merge unrelated histories");
  return mergeOrtInternal(g, repo, bases.reverse(), h1, h2, opts, 0);
}
