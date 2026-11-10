import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  commit,
  log,
  readCommit,
  readTree,
  writeBlob,
  writeFiles,
  writeTree,
} from "../src/commands.js";
import { demoCommits } from "../src/demo.js";
import { encodeCommit, type Person } from "../src/git-format.js";
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
          // edit a large text file: the new blob is a delta against one the store already has
          const f = join(history, "file0.txt");
          writeFileSync(f, `${readFileSync(f, "utf8")}appended line ${k}\n`);
          git(history, ["commit", "-q", "-am", `extra ${k}`]);
        }
        const thin = new Uint8Array(
          git(history, ["pack-objects", "--revs", "--thin", "--stdout", "-q"], "HEAD\n^HEAD~2\n"),
        );
        // git leaves the bases out: a thin pack has fewer objects than it needs
        const idxOf = (p: Uint8Array) => new DataView(p.buffer, p.byteOffset).getUint32(8);
        const r = await repo.objects.installPack(chunks(thin));
        expect(r.count).toBeGreaterThan(idxOf(thin)); // bases appended from the store
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
    // the branch and the merge
    const t3 = mktree([
      `100644 blob ${blob("hello\n")}\tREADME.md`,
      `040000 tree ${mktree([`100644 blob ${blob("# a\n")}\ta.md`])}\tdocs`,
    ]);
    expect(ids.t3).toBe(t3);
    const self = (t: number) => ({
      ...env("a", t),
      GIT_COMMITTER_NAME: "A U Thor",
      GIT_COMMITTER_EMAIL: "a@example.com",
      GIT_COMMITTER_DATE: `${1700000000 + t} +0000`,
    });
    const c3 = ct(t3, [c1], "topic\n", self(120));
    expect(ids.c3).toBe(c3);
    expect(ids.c4).toBe(ct(t2, [c2, c3], "merge topic\n", self(180)));
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
  it("bundled alone, commands.ts pulls in only itself and the pure git-format module", async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../src/commands.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "neutral",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    // every import form counts here (static, dynamic, re-exports, side effects); type imports vanish
    const inputs = Object.keys(out.metafile?.inputs ?? {}).map((p) =>
      p.replace(/^(.*\/)?17-repository\//, ""),
    );
    expect(inputs.sort()).toEqual(["src/commands.ts", "src/git-format.ts"]);
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
      const node = await sqlRepository(await newNodeSqliteDb());
      await demoCommits(node);
      expect(r.log).toEqual(await log(node, "refs/heads/main")); // the same ids in the DO and on Node
      expect(r.log?.length).toBe(4);
      expect(r.fixtureLog).toEqual(expected);
    } finally {
      await mf.dispose();
    }
  }, 300_000);
});

/** Review of #72: byte-exact formats, git's validation, native-git interop, the command layer. */
describe("review cases (#72)", () => {
  const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const mem = () => backends[0]?.[1]() as Promise<Repository>;
  const rawObject = (d: string, type: string, bytes: Uint8Array) =>
    git(d, ["hash-object", "-t", type, "-w", "--literally", "--stdin"], bytes).toString().trim();
  const roundTripTree = async (repo: Repository, bytes: Uint8Array) => {
    const id = await repo.objects.put("tree", bytes);
    const entries = await readTree(repo, id);
    const again = await writeTree(repo, entries);
    return { id, again, entries };
  };
  const treeBytes = (entries: [string, Uint8Array, string][]) =>
    new Uint8Array(
      Buffer.concat(
        entries.flatMap(([mode, name, oid]) => [
          Buffer.from(`${mode} `),
          Buffer.from(name),
          Buffer.from([0]),
          Buffer.from(oid, "hex"),
        ]),
      ),
    );
  const E = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
  it("tree names are bytes: latin-1 and BOM names round-trip to the same id", async () => {
    const repo = await mem();
    const t = treeBytes([
      ["100644", latin1("caf\xe8"), E],
      ["100644", latin1("caf\xe9"), E],
      ["100644", new TextEncoder().encode("﻿a"), E],
    ]);
    const { id, again } = await roundTripTree(repo, t);
    expect(again).toBe(id);
  });
  it("legacy modes (040000, 100664) are read and preserved", async () => {
    const repo = await mem();
    const sub = await repo.objects.put("tree", treeBytes([["100644", latin1("f"), E]]));
    const t = treeBytes([
      ["100664", latin1("a"), E],
      ["040000", latin1("d"), sub],
    ]);
    const { id, again, entries } = await roundTripTree(repo, t);
    expect(again).toBe(id);
    expect(entries.map((e) => e.mode)).toEqual(["100664", "040000"]);
  });
  it("names git's fsck refuses are refused on write", async () => {
    const repo = await mem();
    for (const name of [".GIT", ".Git", "git~1", ".git ", ".git.", ".g‌it", "\uD800"])
      await expect(
        writeTree(repo, [{ mode: "100644", name, oid: E }]),
        JSON.stringify(name),
      ).rejects.toThrow();
    await expect(
      writeTree(repo, [{ mode: "120000", name: ".gitmodules", oid: E }]),
    ).rejects.toThrow();
    await expect(
      writeTree(repo, [
        { mode: "100644", name: "\uD800", oid: E },
        { mode: "100644", name: "\uDC00", oid: E },
      ]),
    ).rejects.toThrow();
  });
  it("commits keep extra headers, the encoding and the message bytes: gpgsig + ISO-8859-1 round-trip", async () => {
    const repo = await mem();
    const tree = await writeFiles(repo, { a: new TextEncoder().encode("a\n") });
    const raw = Buffer.concat([
      Buffer.from(
        `tree ${tree}\nauthor A <a@x> 1700000000 +0000\ncommitter A <a@x> 1700000000 +0000\nencoding ISO-8859-1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----\n\n`,
      ),
      Buffer.from(latin1("caf\xe9\n")),
    ]);
    const id = await repo.objects.put("commit", new Uint8Array(raw));
    const c = await readCommit(repo, id);
    expect(c.encoding).toBe("ISO-8859-1");
    expect(c.message).toBe("café\n");
    const again = await repo.objects.put("commit", encodeCommit(c));
    expect(again).toBe(id);
  });
  it("a commit with a malformed identity re-encodes to the same id", async () => {
    const repo = await mem();
    const tree = await writeFiles(repo, { a: new TextEncoder().encode("a") });
    const raw = `tree ${tree}\nauthor Foo<f@x>  1700000001\ncommitter  Bar <b@x> 1700000002 +0100\n\nm\n`;
    const id = await repo.objects.put("commit", new TextEncoder().encode(raw));
    const c = await readCommit(repo, id);
    expect(c.author.name).toBe("Foo");
    expect(await repo.objects.put("commit", encodeCommit(c))).toBe(id);
  });
  it("git log's tolerance: malformed identities do not abort log", async () => {
    const d = tmp();
    git(d, ["init", "-q", "."]);
    const tree = git(d, ["mktree"], "").toString().trim();
    let parent = "";
    for (const ident of [
      "Foo<f@x> 1700000001 +0000",
      "Foo <f@x> 1700000002",
      "Foo <f@x>  1700000003 +0000",
    ]) {
      const body = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${ident}\ncommitter ${ident}\n\nm\n`;
      parent = rawObject(d, "commit", new TextEncoder().encode(body));
    }
    git(d, ["update-ref", "refs/heads/main", parent]);
    const expected = git(d, ["log", "--format=%H", "main"]).toString().trim().split("\n");
    const repo = await filesRepository(
      new StreamingNodeFilesApi(join(d, ".git")),
      nodeRefFiles(join(d, ".git")),
    );
    expect(await log(repo, "refs/heads/main")).toEqual(expected);
  });
  it("log matches git log with author/committer dates inverted, ties and clock skew", async () => {
    const d = tmp();
    git(d, ["init", "-q", "-b", "main", "."]);
    const at = (a: number, c: number) => ({
      ...gitEnv,
      GIT_AUTHOR_DATE: `${1700000000 + a} +0000`,
      GIT_COMMITTER_DATE: `${1700000000 + c} +0000`,
    });
    const run = (args: string[], e: Record<string, string | undefined>) =>
      execFileSync("git", args, { cwd: d, env: e });
    const plan: [number, number][] = [
      [50, 10],
      [40, 10],
      [30, 5],
      [20, 30],
      [10, 30],
      [0, 25],
    ];
    for (const [i, [a, c]] of plan.entries())
      run(["commit", "-q", "--allow-empty", "-m", `m${i}`], at(a, c));
    run(["checkout", "-q", "-b", "side", "HEAD~3"], gitEnv);
    run(["commit", "-q", "--allow-empty", "-m", "s1"], at(5, 30));
    run(["commit", "-q", "--allow-empty", "-m", "s2"], at(6, 2));
    run(["checkout", "-q", "main"], gitEnv);
    run(["merge", "-q", "--no-ff", "-m", "merge", "side"], at(1, 28));
    const expected = git(d, ["log", "--format=%H", "main"]).toString().trim().split("\n");
    const repo = await filesRepository(
      new StreamingNodeFilesApi(join(d, ".git")),
      nodeRefFiles(join(d, ".git")),
    );
    expect(await log(repo, "refs/heads/main")).toEqual(expected);
  });
  it("log peels annotated tags and stops at a shallow boundary", async () => {
    const src = repoWithHistory(6);
    git(src, ["tag", "-a", "v1", "-m", "v1", "HEAD~2"]);
    const repo = await filesRepository(
      new StreamingNodeFilesApi(join(src, ".git")),
      nodeRefFiles(join(src, ".git")),
    );
    expect(await log(repo, "refs/tags/v1")).toEqual(
      git(src, ["log", "--format=%H", "v1"]).toString().trim().split("\n"),
    );
    const shallow = tmp();
    git(tmpdir(), ["clone", "-q", "--depth", "2", `file://${src}`, shallow]);
    const srepo = await filesRepository(
      new StreamingNodeFilesApi(join(shallow, ".git")),
      nodeRefFiles(join(shallow, ".git")),
    );
    expect(await log(srepo, "HEAD")).toEqual(
      git(shallow, ["log", "--format=%H"]).toString().trim().split("\n"),
    );
  });
  it("packs written by native git after open are found (git gc on an open repository)", async () => {
    const d = repoWithHistory(6);
    const repo = await filesRepository(
      new StreamingNodeFilesApi(join(d, ".git")),
      nodeRefFiles(join(d, ".git")),
    );
    const head = git(d, ["rev-parse", "HEAD"]).toString().trim();
    expect(await repo.objects.has(head)).toBe(true);
    git(d, ["gc", "-q", "--prune=now"]);
    expect((await readCommit(repo, head)).message).toBe("commit 5\n"); // get first (has rescans too)
    expect(await repo.objects.has(head)).toBe(true);
    expect((await log(repo, "HEAD")).length).toBe(6);
  });
  it("a second SQL handle on the same Db sees a pack the first installed", async () => {
    const db = await newNodeSqliteDb();
    const a = await sqlRepository(db);
    const b = await sqlRepository(db);
    const src = repoWithHistory(3);
    await a.objects.installPack(chunks(packAll(src, true)));
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    expect((await b.objects.get(head))?.type).toBe("commit"); // get first (has rescans too)
    expect(await b.objects.has(head)).toBe(true);
  });
  it("writeFiles refuses a path that is both a file and a directory, in either order", async () => {
    const repo = await mem();
    const x = new TextEncoder().encode("x");
    await expect(writeFiles(repo, { "a/b": x, a: x })).rejects.toThrow();
    await expect(writeFiles(repo, { a: x, "a/b": x })).rejects.toThrow();
  });
  it("commit refuses a missing tree or parent, and an unreadable date", async () => {
    const repo = await mem();
    const tree = await writeFiles(repo, { a: new TextEncoder().encode("a") });
    const who = alice(0);
    await expect(
      commit(repo, { ref: "refs/heads/x", tree: "1".repeat(40), author: who, message: "m\n" }),
    ).rejects.toThrow();
    await expect(
      commit(repo, {
        ref: "refs/heads/x",
        tree,
        parents: ["2".repeat(40)],
        author: who,
        message: "m\n",
      }),
    ).rejects.toThrow();
    await expect(
      commit(repo, {
        ref: "refs/heads/x",
        tree,
        author: { ...who, when: Number.NaN },
        message: "m\n",
      }),
    ).rejects.toThrow();
    expect(await repo.refs.resolve("refs/heads/x")).toBeUndefined();
  });
  it("reading an object as the wrong type releases its stream", async () => {
    const repo = await mem();
    const tree = await writeFiles(repo, { a: new TextEncoder().encode("a") });
    let released = 0;
    const get = repo.objects.get.bind(repo.objects);
    repo.objects.get = async (oid, o) => {
      const r = await get(oid, o);
      if (!r) return r;
      const content = r.content;
      return {
        ...r,
        content: {
          [Symbol.asyncIterator]: () => {
            const it = content[Symbol.asyncIterator]();
            return {
              next: () => it.next(),
              return: async () => {
                released++;
                return it.return?.() ?? { done: true, value: undefined };
              },
            };
          },
        } as AsyncIterable<Uint8Array>,
      };
    };
    await expect(readCommit(repo, tree)).rejects.toThrow(/tree/);
    expect(released).toBe(1);
  });
  it("a thin pack's external base over the size limit is refused", async () => {
    const repo = await filesRepository(new MemFilesApi(), memRefFiles(), { maxObjectSize: 1000 });
    const big = await repo.objects.put("blob", new Uint8Array(5000).fill(7));
    const d = tmp();
    git(d, ["init", "-q", "."]);
    // a REF_DELTA against `big`, which the store holds but is over the limit
    const { buildPack, delta } = await import("../../12-index-pack/src/craft.js");
    // the delta copies 10 bytes: only the base is over the limit, and it must not be read at all
    const thin = buildPack([{ kind: 7, baseOid: big, data: delta(5000, 10, [0x90, 10]) }]);
    let baseBytesRead = 0;
    const get = repo.objects.get.bind(repo.objects);
    repo.objects.get = async (oid, o) => {
      const r = await get(oid, o);
      if (!r || oid !== big) return r;
      const content = r.content;
      return {
        ...r,
        content: (async function* () {
          for await (const c of content) {
            baseBytesRead += c.length;
            yield c;
          }
        })(),
      };
    };
    await expect(repo.objects.installPack(chunks(thin))).rejects.toThrow(/limit/);
    expect(baseBytesRead).toBe(0);
  });
});
