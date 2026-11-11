import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Case, compareTrees, type Files, f, rng } from "../../29-merge/tests/tree-harness.js";
import { mergeOrt } from "../../31-ort/src/ort.js";

const run = (cases: Case[]) => compareTrees(cases, { noRenames: false, merge: mergeOrt });

const text = (tag: string, n = 10) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i} of the file\n`).join("");
const keep: [string, string, string] = ["keep", "100644", "kept\n"];
const file = (path: string, tag = path, n = 10): [string, string, string] => [
  path,
  "100644",
  text(tag, n),
];
const edited = (path: string, tag = path): [string, string, string] => [
  path,
  "100644",
  text(tag).replace("line 3", "line 3 edited"),
];

const handMade: Case[] = [
  {
    name: "a directory renamed on ours, a file added to it on theirs (file location)",
    base: f([keep, file("d/a"), file("d/b"), file("d/c")]),
    ours: f([keep, file("e/a", "d/a"), file("e/b", "d/b"), file("e/c", "d/c")]),
    theirs: f([keep, file("d/a"), file("d/b"), file("d/c"), file("d/new")]),
  },
  {
    name: "a file renamed into the old directory",
    base: f([keep, file("d/a"), file("d/b"), file("x")]),
    ours: f([keep, file("e/a", "d/a"), file("e/b", "d/b"), file("x")]),
    theirs: f([keep, file("d/a"), file("d/b"), file("d/x", "x")]),
  },
  {
    name: "a split with no majority (directory rename split)",
    base: f([keep, file("d/a"), file("d/b")]),
    ours: f([keep, file("e/a", "d/a"), file("f/b", "d/b")]),
    theirs: f([keep, file("d/a"), file("d/b"), file("d/new")]),
  },
  {
    name: "two paths mapped to one place (implicit dir rename)",
    base: f([keep, file("a/k1"), file("b/k2")]),
    ours: f([keep, file("c/k1", "a/k1"), file("c/k2", "b/k2")]),
    theirs: f([keep, file("a/k1"), file("b/k2"), file("a/new", "a/new"), file("b/new", "b/new")]),
  },
  {
    name: "an existing path in the way (implicit dir rename)",
    base: f([keep, file("d/a"), file("d/b")]),
    ours: f([keep, file("e/a", "d/a"), file("e/b", "d/b")]),
    theirs: f([keep, file("d/a"), file("d/b"), file("d/new"), file("e/new", "other")]),
  },
  {
    name: "a directory renamed into one the other side renamed away (the warning)",
    base: f([keep, file("d/a"), file("d/b"), file("e/c"), file("e/g")]),
    ours: f([keep, file("e/a", "d/a"), file("e/b", "d/b"), file("e/c"), file("e/g")]),
    theirs: f([
      keep,
      file("d/a"),
      file("d/b"),
      file("f/c", "e/c"),
      file("f/g", "e/g"),
      file("d/new"),
    ]),
  },
  {
    name: "a directory renamed by both sides",
    base: f([keep, file("d/a"), file("d/b")]),
    ours: f([keep, file("e/a", "d/a"), file("e/b", "d/b"), file("d/new1")]),
    theirs: f([keep, file("f/a", "d/a"), file("f/b", "d/b"), file("d/new2")]),
  },
  {
    name: "nested directories",
    base: f([keep, file("a/b/x"), file("a/b/y")]),
    ours: f([keep, file("c/b/x", "a/b/x"), file("c/b/y", "a/b/y")]),
    theirs: f([keep, file("a/b/x"), file("a/b/y"), file("a/b/new")]),
  },
  {
    name: "a basename guess from the directory's majority",
    base: f([keep, file("d/k1"), file("d/k2"), file("d/x.txt"), file("o/x.txt")]),
    ours: f([
      keep,
      file("e/k1", "d/k1"),
      file("e/k2", "d/k2"),
      edited("e/x.txt", "d/x.txt"),
      edited("p/x.txt", "o/x.txt"),
    ]),
    theirs: f([
      keep,
      file("d/k1"),
      file("d/k2"),
      edited("d/x.txt", "d/x.txt t"),
      edited("o/x.txt", "o/x.txt t"),
      file("d/new"),
    ]),
  },
];

/** random merges where whole directories are renamed, split or emptied */
function dirCorpus(n: number, seed: number): Case[] {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const dirs = ["d1", "d2", "d3", "d1/s"];
  const targets = ["e1", "e2", "d2", "e1/s", "d3/t"];
  const names = ["a", "b", "c", "x.txt", "k"];
  let uid = 0;
  const content = () =>
    Array.from({ length: 6 + Math.floor(rand() * 6) }, (_, i) => `line ${seed}-${uid++} ${i}`).join(
      "\n",
    ) + (rand() < 0.8 ? "\n" : "");
  const edit = (s: string) => {
    const ls = s.split("\n");
    ls[Math.floor(rand() * (ls.length - 1))] = `edited ${uid++}`;
    return ls.join("\n");
  };
  const under = (m: Files, d: string) =>
    [...m.keys()].filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/"));
  const free = (m: Files, p: string) =>
    !m.has(p) && ![...m.keys()].some((q) => q.startsWith(`${p}/`) || p.startsWith(`${q}/`));
  const cases: Case[] = [];
  for (let i = 0; i < n; i++) {
    const base: Files = new Map([["keep", ["100644", "kept\n"]]]);
    for (const d of dirs) {
      if (rand() < 0.25) continue;
      const k = 2 + Math.floor(rand() * 3);
      for (let j = 0; j < k; j++) {
        const p = `${d}/${pick(names)}`;
        if (free(base, p)) base.set(p, ["100644", content()]);
      }
    }
    const mutate = (): Files => {
      const m: Files = new Map(base);
      const ops = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < ops; k++) {
        const r = rand();
        const d = pick(dirs);
        const files = under(m, d);
        if (r < 0.35 && files.length) {
          // rename (most of) a directory, or split it
          const to = pick(targets);
          const to2 = pick(targets);
          for (const p of files) {
            if (rand() < 0.15) continue;
            const q = `${rand() < 0.75 ? to : to2}/${p.slice(d.length + 1)}`;
            if (!free(m, q)) continue;
            const [mode, c] = m.get(p) as [string, string];
            m.delete(p);
            m.set(q, [mode, rand() < 0.4 ? edit(c) : c]);
          }
        } else if (r < 0.5) {
          const p = `${d}/new${uid++}`;
          if (free(m, p)) m.set(p, ["100644", content()]);
        } else if (r < 0.62) {
          // a file renamed into a directory
          const all = [...m.keys()].filter((p) => p !== "keep");
          if (!all.length) continue;
          const p = pick(all);
          const q = `${d}/${p.split("/").pop()}${rand() < 0.5 ? "" : uid++}`;
          if (!free(m, q)) continue;
          const v = m.get(p) as [string, string];
          m.delete(p);
          m.set(q, v);
        } else if (r < 0.8) {
          const all = [...m.keys()].filter((p) => p !== "keep");
          if (!all.length) continue;
          const p = pick(all);
          const [mode, c] = m.get(p) as [string, string];
          m.set(p, [mode, edit(c)]);
        } else if (r < 0.9) {
          const all = [...m.keys()].filter((p) => p !== "keep");
          if (all.length) m.delete(pick(all));
        } else for (const p of files) m.delete(p);
      }
      return m;
    };
    cases.push({ name: `#${i}`, base, ours: mutate(), theirs: mutate() });
  }
  return cases;
}

describe("E2–E4 directory renames", () => {
  let kinds: string[] = [];
  it("E2: hand-made cases", async () => {
    const r = await run(handMade);
    expect(r.wrong).toEqual([]);
  });

  it("E2b: a rename into itself after a directory rename (git 2.43 asserts)", async (ctx) => {
    const c: Case = {
      name: "rename into itself",
      base: f([keep, file("d/a"), file("d/b"), file("e/x")]),
      ours: f([keep, file("e/a", "d/a"), file("e/b", "d/b"), file("e/x")]),
      theirs: f([keep, file("d/a"), file("d/b"), file("d/x", "e/x")]),
    };
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run([c]);
    } catch (e) {
      if (/Assertion|core dumped|signal/i.test(String(e))) return ctx.skip();
      throw e;
    }
    expect(r.wrong).toEqual([]);
  });

  it("E3: 1000 random merges with directory renames", async () => {
    const r = await run(dirCorpus(1000, 606));
    kinds = r.kinds;
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
  }, 900_000);

  it("E4: the corpus reaches every directory-rename message", () => {
    const count = (k: string) => kinds.filter((x) => x === k).length;
    for (const k of ["file location", "directory rename split", "implicit dir rename"])
      expect(count(k), k).toBeGreaterThan(0);
  });
});

describe("E5 portable", () => {
  it("31-ort/src and 30-renames/src have no node: imports", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const dir of ["../../31-ort/src", "../../30-renames/src"])
      for (const file of readdirSync(join(here, dir)))
        expect(readFileSync(join(here, dir, file), "utf8"), file).not.toMatch(/from "node:/);
  });
});
