import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Case,
  compareTrees,
  corpus,
  type Files,
  f,
  handMade,
  reviewCases,
  rng,
} from "../../29-merge/tests/tree-harness.js";
import { mergeOrt } from "../src/ort.js";

const run = (cases: Case[], opts: { unrelated?: boolean } = {}) =>
  compareTrees(cases, { ...opts, noRenames: false, merge: mergeOrt });

describe("O1 X13b's corpora on the structural port", () => {
  const corpora: [string, () => Case[], { unrelated?: boolean }?][] = [
    ["T1", () => corpus(400, 101)],
    ["T1b", () => corpus(1000, 7)],
    ["T1c", () => corpus(400, 202, { names: ["a", "b", "a~{O}", "a~{O}_0", "a~{T}", "b~{T}"] })],
    ["T1d", () => corpus(300, 303, { fanout: 12 })],
    ["T1e", () => corpus(200, 404), { unrelated: true }],
    ["T4+T5", () => [...handMade, ...reviewCases]],
  ];
  for (const [name, make, opts] of corpora)
    it(`${name} equal to git merge-tree`, async () => {
      const r = await run(make(), opts);
      expect(r.wrong.slice(0, 2)).toEqual([]);
      expect(r.wrong.length).toBe(0);
    }, 600_000);
});

const text = (tag: string, n = 10) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i} of the file\n`).join("");
const editLine = (s: string, k: number, to: string) => {
  const ls = s.split("\n");
  ls[k] = to;
  return ls.join("\n");
};

/** one case per rename kind; {O} and {T} are the branch names as path~branch spells them */
export const renameCases: Case[] = (() => {
  const A = text("alpha");
  const B = text("beta");
  const keep: [string, string, string] = ["keep", "100644", "kept\n"];
  return [
    {
      name: "rename on ours, edit on theirs: clean, at the new path",
      base: f([keep, ["a/x", "100644", A]]),
      ours: f([keep, ["b/y", "100644", A]]),
      theirs: f([keep, ["a/x", "100644", editLine(A, 2, "theirs edit")]]),
    },
    {
      name: "rename and edit against an edit: markers labelled branch:path",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep, ["b", "100644", editLine(A, 5, "ours edit")]]),
      theirs: f([keep, ["a", "100644", editLine(A, 5, "theirs edit")]]),
    },
    {
      name: "rename/delete",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep, ["b", "100644", A]]),
      theirs: f([keep]),
    },
    {
      name: "rename/delete with an edit",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep]),
      theirs: f([keep, ["b", "100644", editLine(A, 3, "edited")]]),
    },
    {
      name: "rename/rename (1to2)",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep, ["b", "100644", A]]),
      theirs: f([keep, ["c", "100644", A]]),
    },
    {
      name: "rename/rename (1to2) with a content conflict: 8-character markers",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep, ["b", "100644", editLine(A, 5, "ours edit")]]),
      theirs: f([keep, ["c", "100644", editLine(A, 5, "theirs edit")]]),
    },
    {
      name: "rename/rename (1to1) with edits",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep, ["b", "100644", editLine(A, 1, "ours edit")]]),
      theirs: f([keep, ["b", "100644", editLine(A, 8, "theirs edit")]]),
    },
    {
      name: "rename/add",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep, ["b", "100644", A]]),
      theirs: f([keep, ["a", "100644", A], ["b", "100644", B]]),
    },
    {
      name: "rename/add with a content conflict: the collision message",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep, ["b", "100644", editLine(A, 4, "ours edit")]]),
      theirs: f([keep, ["a", "100644", editLine(A, 4, "theirs edit")], ["b", "100644", B]]),
    },
    {
      name: "rename/rename (2to1)",
      base: f([keep, ["a", "100644", A], ["b", "100644", B]]),
      ours: f([keep, ["c", "100644", A], ["b", "100644", B]]),
      theirs: f([keep, ["a", "100644", A], ["c", "100644", B]]),
    },
    {
      name: "rename against a type change",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep, ["b", "100644", A]]),
      theirs: f([keep, ["a", "120000", "target"]]),
    },
    {
      name: "a rename with a mode change against an edit",
      base: f([keep, ["a", "100644", A]]),
      ours: f([keep, ["b", "100755", A]]),
      theirs: f([keep, ["a", "100644", editLine(A, 9, "theirs edit")]]),
    },
  ];
})();

/** random merges with renames; every directory keeps a file neither side touches */
function renameCorpus(n: number, seed: number): Case[] {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const dirs = ["", "d1/", "d2/", "d1/e/"];
  const names = ["x", "y", "z", "w.txt", "v.txt", "u"];
  const words = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta", "theta"];
  let uid = 0;
  const content = () =>
    Array.from({ length: 6 + Math.floor(rand() * 10) }, (_, i) =>
      rand() < 0.3 ? `${pick(words)} ${pick(words)}` : `line ${seed}-${uid++} ${i}`,
    ).join("\n") + "\n";
  const edit = (s: string) => {
    const ls = s.split("\n");
    const k = Math.floor(rand() * (ls.length - 1));
    if (rand() < 0.5) ls[k] = `edited ${uid++}`;
    else ls.splice(k, 0, `inserted ${uid++}`);
    return ls.join("\n");
  };
  const isKeep = (p: string) => p.endsWith("keep");
  const freePath = (m: Files) => {
    for (let t = 0; t < 30; t++) {
      const p = `${pick(dirs)}${pick(names)}`;
      if (!m.has(p)) return p;
    }
    return `${pick(dirs)}n${uid++}`;
  };
  const cases: Case[] = [];
  for (let i = 0; i < n; i++) {
    const base: Files = new Map(dirs.map((d) => [`${d}keep`, ["100644", `keep ${d}\n`]]));
    const count = 1 + Math.floor(rand() * 5);
    for (let k = 0; k < count; k++)
      base.set(freePath(base), [rand() < 0.85 ? "100644" : "100755", content()]);
    const renamesOf: Map<string, string>[] = [new Map(), new Map()];
    const mutate = (s: 0 | 1): Files => {
      const m: Files = new Map(base);
      const ops = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < ops; k++) {
        const files = [...m.keys()].filter((p) => !isKeep(p));
        const r = rand();
        if (!files.length) {
          m.set(freePath(m), ["100644", content()]);
          continue;
        }
        const p = pick(files);
        const [mode, c] = m.get(p) as [string, string];
        if (r < 0.45) {
          // a rename, maybe to where the other side renamed the same file, maybe edited
          const other = renamesOf[1 - s]?.get(p);
          const q = other && rand() < 0.4 && !m.has(other) ? other : freePath(m);
          m.delete(p);
          m.set(q, [
            rand() < 0.1 ? (mode === "100644" ? "100755" : "100644") : mode,
            rand() < 0.5 ? edit(c) : c,
          ]);
          renamesOf[s]?.set(p, q);
        } else if (r < 0.65) m.set(p, [mode, edit(c)]);
        else if (r < 0.75) m.delete(p);
        else if (r < 0.82) m.set(p, ["120000", `link ${uid++}`]);
        else if (r < 0.9) {
          // a new file where another file was, or will be renamed to
          const q = rand() < 0.5 ? pick(files) : freePath(m);
          m.set(q, ["100644", content()]);
        } else m.set(freePath(m), ["100644", content()]);
      }
      return m;
    };
    const ours = mutate(0);
    const theirs = mutate(1);
    cases.push({ name: `#${i}`, base, ours, theirs });
  }
  return cases;
}

describe("O2–O4 renames", () => {
  let kinds: string[] = [];
  it("O3: one case per rename kind", async () => {
    const r = await run(renameCases);
    expect(r.wrong).toEqual([]);
  });

  it("O2: 1000 random merges with renames", async () => {
    const r = await run(renameCorpus(1000, 505));
    kinds = r.kinds;
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
  }, 600_000);

  it("O4: the corpus reaches every rename kind", () => {
    const count = (k: string) => kinds.filter((x) => x === k).length;
    for (const k of ["rename/delete", "rename/rename", "rename involved in collision", "content"])
      expect(count(k), k).toBeGreaterThan(0);
  });
});

describe("O5 portable", () => {
  it("src/ has no node: imports", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const file of readdirSync(src))
      expect(readFileSync(join(src, file), "utf8"), file).not.toMatch(/from "node:/);
  });
});
