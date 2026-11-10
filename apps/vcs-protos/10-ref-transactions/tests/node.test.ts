import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { memKvStore } from "@statewalker/webrun-storage";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlKvStore } from "../../08-sqlite-kv-cas/src/sql-kv-store.js";
import { memRefFiles } from "../src/adapters/mem.js";
import { nodeRefFiles } from "../src/adapters/node.js";
import { filesRefDb, type RefFiles } from "../src/files-ref-db.js";
import { kvRefDb, snapshotSize } from "../src/kv-ref-db.js";
import { oid, runRefContract } from "../src/ref-contract.js";
import { checkRefFormat } from "../src/refname.js";
import { REFNAME_TABLE } from "../src/refname-table.js";
import { sqlRefDb } from "../src/sql-ref-db.js";

const CASES = 12;
const IDENT = "A U Thor <author@example.com> 1700000000 +0000";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@b",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@b",
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, env: gitEnv, input, encoding: "utf8" }).trim();
const gitTry = (cwd: string, args: string[], input?: string) =>
  spawnSync("git", args, { cwd, env: gitEnv, input, encoding: "utf8" });
const newRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "x5-"));
  dirs.push(d);
  git(d, ["init", "-q", "-b", "main", "."]);
  return d;
};
/** n real commits in `repo`, oldest first. */
const commits = (repo: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    git(repo, ["commit-tree", "-m", `c${i}`, "4b825dc642cb6eb9a060e54bf8d69288fbee4904"]),
  );

describe("R1 ref names follow git check-ref-format", () => {
  for (const allowOneLevel of [false, true]) {
    it(`${REFNAME_TABLE.length} names, ${allowOneLevel ? "--allow-onelevel" : "default"}`, () => {
      const cwd = newRepo();
      const diffs: string[] = [];
      for (const name of REFNAME_TABLE) {
        const args = ["check-ref-format", ...(allowOneLevel ? ["--allow-onelevel"] : []), name];
        const gitSays = gitTry(cwd, args).status === 0;
        if (checkRefFormat(name, { allowOneLevel }) !== gitSays)
          diffs.push(`${JSON.stringify(name)} git=${gitSays}`);
      }
      expect(REFNAME_TABLE.length).toBeGreaterThanOrEqual(50);
      expect(diffs).toEqual([]);
    });
  }
});

describe("R2–R5 contract on every Node backend", () => {
  const backends: [
    string,
    () => Promise<Parameters<typeof runRefContract>[0] extends () => Promise<infer D> ? D : never>,
  ][] = [
    ["git files on memory", async () => filesRefDb(memRefFiles())],
    [
      "git files on Node fs (a real .git)",
      async () => filesRefDb(nodeRefFiles(join(newRepo(), ".git"))),
    ],
    [
      "SQL on node:sqlite (one inTransaction per batch)",
      async () => sqlRefDb(await newNodeSqliteDb()),
    ],
    ["KV on memKvStore (root compare-and-set)", async () => kvRefDb(memKvStore())],
    [
      "KV on sqlKvStore over node:sqlite (X3a)",
      async () => kvRefDb(await sqlKvStore(await newNodeSqliteDb())),
    ],
  ];
  for (const [name, make] of backends) {
    it(name, async () => {
      const r = await runRefContract(make);
      expect(r.cases).toBe(CASES);
      expect(r.failed).toEqual([]);
    }, 60_000);
  }
});

describe("R6 git files interop", () => {
  it("native git reads our refs, packed-refs, symbolic HEAD and reflogs", async () => {
    const repo = newRepo();
    const [c0, c1, c2] = commits(repo, 3) as [string, string, string];
    const db = filesRefDb(nodeRefFiles(join(repo, ".git")));
    expect(
      (
        await db.batch([{ name: "refs/heads/main", old: null, new: c0 }], {
          ident: IDENT,
          message: "single",
        })
      ).ok,
    ).toBe(true);
    const r = await db.batch(
      [
        { name: "refs/heads/main", old: c0, new: c1 },
        { name: "refs/heads/topic", old: null, new: c2 },
        { name: "refs/tags/t1", old: null, new: c0 },
      ],
      { ident: IDENT, message: "batch" },
    );
    expect(r).toEqual({ ok: true, rejected: [] });
    expect(git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
      [`refs/heads/main ${c1}`, `refs/heads/topic ${c2}`, `refs/tags/t1 ${c0}`].join("\n"),
    );
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(c1); // git's own HEAD -> refs/heads/main
    expect(git(repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(git(repo, ["reflog", "show", "--format=%H %gs", "refs/heads/main"])).toBe(
      `${c1} batch\n${c0} single`,
    );
    expect(gitTry(repo, ["fsck", "--no-dangling"]).status).toBe(0);
    expect(await db.setSymref("HEAD", "refs/heads/topic", "refs/heads/main")).toBe(true);
    expect(git(repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/topic");
  });
  it("we read refs git wrote loose and packed, keep its peel lines, and git reads our rewrite", async () => {
    const repo = newRepo();
    const [c0, c1, c2] = commits(repo, 3) as [string, string, string];
    git(repo, ["update-ref", "refs/heads/main", c0]);
    git(repo, ["update-ref", "refs/heads/old", c1]);
    git(repo, ["tag", "-a", "-m", "annotated", "v1", c0]);
    git(repo, ["pack-refs", "--all"]);
    git(repo, ["update-ref", "refs/heads/loose", c2]); // loose after packing
    const tagObj = git(repo, ["rev-parse", "refs/tags/v1"]);
    expect(readFileSync(join(repo, ".git", "packed-refs"), "utf8")).toContain(`^${c0}`);
    const db = filesRefDb(nodeRefFiles(join(repo, ".git")));
    expect(await db.resolve("refs/heads/main")).toBe(c0);
    expect(await db.resolve("refs/tags/v1")).toBe(tagObj);
    expect(await db.resolve("refs/heads/loose")).toBe(c2);
    expect(await db.resolve("HEAD")).toBe(c0);
    const r = await db.batch([
      { name: "refs/heads/old", old: c1, new: null }, // packed delete
      { name: "refs/heads/loose", old: c2, new: c1 }, // loose update
      { name: "refs/heads/main", old: c0, new: c2 }, // packed update
    ]);
    expect(r.ok).toBe(true);
    expect(git(repo, ["for-each-ref", "--format=%(refname) %(objectname) %(*objectname)"])).toBe(
      [`refs/heads/loose ${c1} `, `refs/heads/main ${c2} `, `refs/tags/v1 ${tagObj} ${c0}`].join(
        "\n",
      ),
    );
    expect(readFileSync(join(repo, ".git", "packed-refs"), "utf8")).toContain(`^${c0}`); // peel kept
    expect(gitTry(repo, ["show-ref", "--verify", "refs/heads/old"]).status).not.toBe(0);
  });
  it("our locks block git update-ref, and git's locks make our batch report locked", async () => {
    const repo = newRepo();
    const [c0, c1] = commits(repo, 2) as [string, string];
    git(repo, ["update-ref", "refs/heads/main", c0]);
    const files = nodeRefFiles(join(repo, ".git"));
    // git holds the lock (as during its own transaction)
    expect(
      await files.createExclusive("refs/heads/main.lock", new TextEncoder().encode(`${c1}\n`)),
    ).toBe(true);
    const db = filesRefDb(files, { refLockTimeoutMs: 50 });
    const r = await db.batch([
      { name: "refs/heads/main", old: c0, new: c1 },
      { name: "refs/heads/x", new: c1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.rejected).toContainEqual({ name: "refs/heads/main", reason: "locked" });
    expect(
      readdirSync(join(repo, ".git", "refs", "heads")).filter((n) => n.endsWith(".lock")),
    ).toEqual(["main.lock"]);
    await files.remove("refs/heads/main.lock");
    // we hold packed-refs.lock as during a batch: git's own transaction cannot rewrite packed-refs
    expect(await files.createExclusive("packed-refs.lock", new Uint8Array(0))).toBe(true);
    const g = gitTry(repo, [
      "-c",
      "core.packedRefsTimeout=0",
      "update-ref",
      "-d",
      "refs/heads/main",
    ]);
    expect(g.status).not.toBe(0);
    expect(g.stderr).toMatch(/packed-refs\.lock|Unable to create/);
  });
});

/** RefFiles that dies at the k-th primitive call: that call and every later one throw. */
function dyingAt(inner: RefFiles, k: number) {
  let calls = 0;
  let dead = false;
  const gate = () => {
    calls++;
    if (dead || calls === k) {
      dead = true;
      throw new Error(`crash at call ${k}`);
    }
  };
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A) => {
      gate();
      return fn(...a);
    };
  const self: RefFiles = {
    read: (p) => ({
      async *[Symbol.asyncIterator]() {
        gate();
        yield* inner.read(p);
      },
    }),
    exists: wrap(inner.exists),
    remove: wrap(inner.remove),
    createExclusive: wrap(inner.createExclusive),
    replace: wrap(inner.replace),
    write: wrap(inner.write),
    list: (d) => ({
      async *[Symbol.asyncIterator]() {
        gate();
        yield* inner.list(d);
      },
    }),
  };
  return { files: self, calls: () => calls };
}

describe("R7 crash at every primitive call (git files)", () => {
  it("each crash leaves all old or all new values once stale locks are broken", async () => {
    const repo = newRepo();
    const cs = commits(repo, 6);
    const names = ["refs/heads/a", "refs/heads/b", "refs/heads/c"];
    const outcomes = new Set<string>();
    let completed = false;
    for (let k = 1; k <= 400 && !completed; k++) {
      // fresh state: a packed, b loose, c absent
      const gitDir = join(newRepo(), ".git");
      const base = nodeRefFiles(gitDir);
      const setup = filesRefDb(base);
      await setup.batch([
        { name: "refs/heads/a", new: cs[0] as string },
        { name: "refs/heads/b", new: cs[1] as string },
      ]);
      expect(
        (await setup.batch([{ name: "refs/heads/b", old: cs[1] as string, new: cs[1] as string }]))
          .ok,
      ).toBe(true);
      const before = await Promise.all(names.map((n) => setup.resolve(n)));
      const { files } = dyingAt(base, k);
      let threw = false;
      try {
        const r = await filesRefDb(files).batch([
          { name: "refs/heads/a", old: cs[0] as string, new: cs[3] as string },
          { name: "refs/heads/b", old: cs[1] as string, new: null },
          { name: "refs/heads/c", old: null, new: cs[5] as string },
        ]);
        if (r.ok) completed = true;
      } catch {
        threw = true;
      }
      for await (const p of base.list("refs")) if (p.endsWith(".lock")) await base.remove(p);
      await base.remove("packed-refs.lock");
      const after = await Promise.all(names.map((n) => filesRefDb(base).resolve(n)));
      const isOld = after.every((v, i) => v === before[i]);
      const isNew = after[0] === cs[3] && after[1] === undefined && after[2] === cs[5];
      expect(isOld || isNew, `crash at call ${k}: ${JSON.stringify(after)}`).toBe(true);
      outcomes.add(`${threw ? "crash" : "done"}:${isNew ? "new" : "old"}`);
    }
    expect(completed).toBe(true);
    console.log("R7 outcomes:", [...outcomes].join(", "));
    expect(outcomes.has("crash:old")).toBe(true);
  }, 120_000);
});

describe("R8 KV snapshot size", () => {
  it("10 000 refs fit one Durable Object value (< 2 MB)", () => {
    const size = snapshotSize(10_000);
    console.log(`R8 KV root value for 10 000 refs: ${(size / 1024).toFixed(0)} KiB`);
    expect(size).toBeLessThan(2_000_000);
  });
});

describe("R8 Durable Object on workerd", () => {
  let mf: Miniflare;
  beforeAll(async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../src/do-entry.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-07-01",
      durableObjects: { REFS: { className: "RefsDo", useSQLite: true } },
    });
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
  });
  for (const kind of ["sql", "kv"]) {
    it(`contract inside the Durable Object (${kind})`, async () => {
      const r = (await (
        await mf.dispatchFetch(`http://x/contract?kind=${kind}`, { method: "POST" })
      ).json()) as {
        cases: number;
        failed: string[];
      };
      expect(r.cases).toBe(CASES);
      expect(r.failed).toEqual([]);
    }, 60_000);
  }
});

void oid;
