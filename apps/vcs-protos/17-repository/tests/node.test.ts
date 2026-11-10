import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { memRefFiles } from "../../10-ref-transactions/src/adapters/mem.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, gitEnv, packAll, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { commit, log, readCommit, readTree, writeBlob, writeFiles } from "../src/commands.js";
import type { Person } from "../src/git-format.js";
import { filesRepository, type Repository, sqlRepository } from "../src/repository.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x16-"));
  dirs.push(d);
  return d;
};
async function* chunks(bytes: Uint8Array, size = 65536) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const collect = async (s: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
};
const enc = new TextEncoder();

const backends: [string, () => Promise<Repository>][] = [
  ["git files (memory)", () => filesRepository(new MemFilesApi(), memRefFiles())],
  ["SQL (one node:sqlite Db)", async () => sqlRepository(await newNodeSqliteDb())],
];

const alice = (t: number): Person => ({
  name: "A U Thor",
  email: "a@example.com",
  when: 1700000000 + t,
  tz: "+0000",
});
const bob = (t: number): Person => ({
  name: "C O Mitter",
  email: "c@example.com",
  when: 1700000000 + t,
  tz: "-0130",
});

/** The R2 command sequence; returns everything it produced. */
async function scenario(repo: Repository) {
  const ids: Record<string, string> = {};
  ids.readme = await writeBlob(repo, enc.encode("hello\n"));
  ids.t1 = await writeFiles(repo, {
    "README.md": enc.encode("hello\n"),
    "src/main.ts": enc.encode("console.log(1)\n"),
    "src/lib/util.ts": enc.encode("export const x = 1;\n"),
    // "lib.ts" sorts before the tree "lib" only under git's rule (a tree compares as "lib/")
    "src/lib.ts": enc.encode("export * from './lib/util';\n"),
  });
  const c1 = await commit(repo, {
    ref: "refs/heads/main",
    tree: ids.t1,
    author: alice(0),
    message: "first\n",
  });
  ids.c1 = c1.oid;
  ids.t2 = await writeFiles(repo, {
    "README.md": enc.encode("hello world\n"),
    "src/main.ts": enc.encode("console.log(1)\n"),
    "src/lib/util.ts": enc.encode("export const x = 2;\n"),
  });
  ids.c2 = (
    await commit(repo, {
      ref: "refs/heads/main",
      tree: ids.t2,
      parents: [ids.c1],
      author: alice(60),
      committer: bob(61),
      message: "second\n\nbody line\n",
    })
  ).oid;
  // a branch from c1, then a merge into main
  ids.t3 = await writeFiles(repo, {
    "README.md": enc.encode("hello\n"),
    "docs/a.md": enc.encode("# a\n"),
  });
  ids.c3 = (
    await commit(repo, {
      ref: "refs/heads/topic",
      tree: ids.t3,
      parents: [ids.c1],
      author: alice(120),
      message: "topic\n",
      expected: null,
    })
  ).oid;
  ids.c4 = (
    await commit(repo, {
      ref: "refs/heads/main",
      tree: ids.t2,
      parents: [ids.c2, ids.c3],
      author: alice(180),
      message: "merge topic\n",
    })
  ).oid;
  // a stale compare-and-swap is rejected and moves nothing
  const stale = await commit(repo, {
    ref: "refs/heads/main",
    tree: ids.t1,
    parents: [ids.c2],
    author: alice(240),
    message: "stale\n",
    expected: ids.c2,
  });
  const refs: Record<string, string | undefined> = {};
  for await (const r of repo.refs.list("refs/")) refs[r.name] = r.oid;
  return { ids, refs, stale: stale.result, log: await log(repo, "refs/heads/main") };
}

describe("R1 ObjectStore contract", () => {
  for (const [name, open] of backends) {
    describe(name, () => {
      it("put / get / has / list", async () => {
        const repo = await open();
        const a = await repo.objects.put("blob", enc.encode("a\n"));
        const b = await repo.objects.put("blob", enc.encode(""));
        expect(a).toBe("78981922613b2afb6025042ff6bd878ac1994e85");
        expect(b).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
        expect(await repo.objects.has(a)).toBe(true);
        expect(await repo.objects.has("0".repeat(40))).toBe(false);
        const o = await repo.objects.get(a, { verify: true });
        expect(o?.type).toBe("blob");
        expect(
          new TextDecoder().decode(await collect(o?.content ?? (async function* () {})())),
        ).toBe("a\n");
        const ids: string[] = [];
        for await (const id of repo.objects.list()) ids.push(id);
        expect(ids.sort()).toEqual([a, b].sort());
      });
      it("installed native-git packs read back as git cat-file; a thin pack is completed from the store", async () => {
        const repo = await open();
        const history = repoWithHistory(12);
        const base = packAll(history, true);
        await repo.objects.installPack(chunks(base));
        const listed = git(history, [
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname) %(objecttype)",
        ])
          .toString()
          .trim()
          .split("\n");
        for (const line of listed) {
          const [id, type] = line.split(" ") as [string, string];
          const o = await repo.objects.get(id, { verify: true });
          expect(o?.type, id).toBe(type);
          const bytes = await collect(o?.content ?? (async function* () {})());
          expect(Buffer.compare(Buffer.from(bytes), git(history, ["cat-file", type, id])), id).toBe(
            0,
          );
        }
        // a thin pack of two more commits: its bases are in the store
        for (let k = 0; k < 2; k++) {
          git(history, ["commit", "-q", "--allow-empty", "-m", `extra ${k}`]);
        }
        const thin = new Uint8Array(
          git(history, ["pack-objects", "--revs", "--thin", "--stdout", "-q"], "HEAD\n^HEAD~2\n"),
        );
        const r = await repo.objects.installPack(chunks(thin));
        expect(r.count).toBeGreaterThan(0);
        const head = git(history, ["rev-parse", "HEAD"]).toString().trim();
        expect((await repo.objects.get(head, { verify: true }))?.type).toBe("commit");
      });
    });
  }
});

describe("R2 the same commands give the same ids on both backends, equal to native git's", () => {
  it("identical ids, refs, logs; a stale CAS rejected", async () => {
    const results = [];
    for (const [, open] of backends) results.push(await scenario(await open()));
    const [a, b] = results as [
      Awaited<ReturnType<typeof scenario>>,
      Awaited<ReturnType<typeof scenario>>,
    ];
    expect(b.ids).toEqual(a.ids);
    expect(b.refs).toEqual(a.refs);
    expect(b.log).toEqual(a.log);
    expect(a.stale.ok).toBe(false);
    expect(a.refs["refs/heads/main"]).toBe(a.ids.c4);
    expect(a.log).toEqual([a.ids.c4, a.ids.c3, a.ids.c2, a.ids.c1]);
  });
  it("tree and commit ids equal git mktree / git commit-tree", async () => {
    const { ids } = await scenario((await backends[0]?.[1]()) as Repository);
    const d = tmp();
    git(d, ["init", "-q", "."]);
    const blob = (s: string) => git(d, ["hash-object", "-w", "--stdin"], s).toString().trim();
    const mktree = (lines: string[]) =>
      git(d, ["mktree"], `${lines.join("\n")}\n`)
        .toString()
        .trim();
    const util = mktree([`100644 blob ${blob("export const x = 1;\n")}\tutil.ts`]);
    const src = mktree([
      `040000 tree ${util}\tlib`,
      `100644 blob ${blob("export * from './lib/util';\n")}\tlib.ts`,
      `100644 blob ${blob("console.log(1)\n")}\tmain.ts`,
    ]);
    const t1 = mktree([`100644 blob ${blob("hello\n")}\tREADME.md`, `040000 tree ${src}\tsrc`]);
    expect(ids.t1).toBe(t1);
    const env = (who: "a" | "c", t: number, tz = "+0000"): Record<string, string> =>
      who === "a"
        ? {
            GIT_AUTHOR_NAME: "A U Thor",
            GIT_AUTHOR_EMAIL: "a@example.com",
            GIT_AUTHOR_DATE: `${1700000000 + t} ${tz}`,
          }
        : {
            GIT_COMMITTER_NAME: "C O Mitter",
            GIT_COMMITTER_EMAIL: "c@example.com",
            GIT_COMMITTER_DATE: `${1700000000 + t} ${tz}`,
          };
    const ct = (tree: string, parents: string[], msg: string, e: Record<string, string>) => {
      return execFileSync("git", ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])], {
        cwd: d,
        env: { ...gitEnv, ...e },
        input: msg,
      })
        .toString()
        .trim();
    };
    const c1 = ct(t1, [], "first\n", {
      ...env("a", 0),
      GIT_COMMITTER_NAME: "A U Thor",
      GIT_COMMITTER_EMAIL: "a@example.com",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    });
    expect(ids.c1).toBe(c1);
    const t2 = ids.t2 as string;
    git(d, ["cat-file", "-e", t1]);
    // c2 needs t2 in git's store: rebuild it from the same files
    const util2 = mktree([`100644 blob ${blob("export const x = 2;\n")}\tutil.ts`]);
    const src2 = mktree([
      `040000 tree ${util2}\tlib`,
      `100644 blob ${blob("console.log(1)\n")}\tmain.ts`,
    ]);
    expect(
      mktree([`100644 blob ${blob("hello world\n")}\tREADME.md`, `040000 tree ${src2}\tsrc`]),
    ).toBe(t2);
    const c2 = ct(t2, [c1], "second\n\nbody line\n", { ...env("a", 60), ...env("c", 61, "-0130") });
    expect(ids.c2).toBe(c2);
  });
});

describe("R3 interop with native git on Node files", () => {
  const repoOf = async (dir: string) =>
    filesRepository(new StreamingNodeFilesApi(join(dir, ".git")), nodeRefFiles(join(dir, ".git")));
  it("a history written by the command layer passes git fsck and git log", async () => {
    const d = tmp();
    git(d, ["init", "-q", "-b", "main", "."]);
    const repo = await repoOf(d);
    const { ids, log: ours } = await scenario(repo);
    git(d, ["fsck", "--full", "--strict"]);
    expect(git(d, ["log", "--format=%H", "main"]).toString().trim().split("\n")).toEqual(ours);
    expect(git(d, ["rev-parse", "topic"]).toString().trim()).toBe(ids.c3);
  });
  it("a repository written by native git gives git's log, loose and after git gc", async () => {
    const d = repoWithHistory(15);
    const expected = git(d, ["log", "--format=%H", "main"]).toString().trim().split("\n");
    expect(await log(await repoOf(d), "refs/heads/main")).toEqual(expected);
    git(d, ["gc", "-q"]);
    expect(readdirSync(join(d, ".git", "objects", "pack")).some((n) => n.endsWith(".pack"))).toBe(
      true,
    );
    const repo = await repoOf(d);
    expect(await log(repo, "HEAD")).toEqual(expected);
    const head = await readCommit(repo, expected[0] as string);
    expect(head.message).toBe("commit 14\n");
    const tree = await readTree(repo, head.tree);
    expect(tree.map((e) => e.name)).toContain("file0.txt");
  });
});

describe("R4 the command layer imports no concrete backend", () => {
  it("only type imports of the interfaces and the pure git-format module", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/commands.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)].map(
      (m) => ({
        type: Boolean(m[1]),
        from: m[2] as string,
      }),
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      if (i.from === "./git-format.js") continue; // pure encoders
      expect(i.type, `${i.from} must be a type-only import`).toBe(true);
      expect([
        "./object-store.js",
        "./repository.js",
        "../../10-ref-transactions/src/ref-db.js",
      ]).toContain(i.from);
    }
  });
});

describe("R5 the SQL backend inside a Durable Object", () => {
  it("commands, the fixture pack installed, its history read", async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../src/do-entry.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
      loader: { ".pack": "binary", ".idx": "binary" },
    });
    const mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-07-01",
      durableObjects: { REPO: { className: "RepoDo", useSQLite: true } },
    });
    try {
      // the fixture pack's history, by native git: index it, take the commit no other commit names
      const src = tmp();
      git(src, ["init", "-q", "."]);
      git(
        src,
        ["index-pack", "--stdin"],
        readFileSync(
          fileURLToPath(new URL("../../12-index-pack/fixtures/sample.pack", import.meta.url)),
        ),
      );
      const commits = git(src, [
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
      ])
        .toString()
        .trim()
        .split("\n")
        .filter((l) => l.endsWith(" commit"))
        .map((l) => l.split(" ")[0] as string);
      const parents = new Set(
        commits.flatMap((c) =>
          git(src, ["rev-parse", `${c}^@`])
            .toString()
            .trim()
            .split("\n")
            .filter(Boolean),
        ),
      );
      const head = commits.find((c) => !parents.has(c)) as string;
      const expected = git(src, ["log", "--format=%H", head]).toString().trim().split("\n");
      const r = (await (
        await mf.dispatchFetch(`http://x/run?head=${head}`, { method: "POST" })
      ).json()) as {
        log?: string[];
        fixtureLog?: string[];
        error?: string;
      };
      expect(r.error).toBeUndefined();
      expect(r.log?.length).toBe(4);
      expect(r.fixtureLog).toEqual(expected);
    } finally {
      await mf.dispose();
    }
  }, 300_000);
});
