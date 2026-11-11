import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { commit, log, writeFiles } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository, sqlRepository } from "../../17-repository/src/repository.js";
import { gc, gcStep, withLease } from "../src/gc.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x18-"));
  dirs.push(d);
  return d;
};
const openBare = (dir: string) =>
  filesRepository(new StreamingNodeFilesApi(dir), nodeRefFiles(dir));
const rev = (d: string, r: string) => git(d, ["rev-parse", r]).toString().trim();
const objectsOf = (d: string) =>
  git(d, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
const packsOf = (d: string) =>
  readdirSync(join(d, "objects", "pack")).filter((n) => n.endsWith(".pack"));
const looseCount = (d: string) =>
  Number(/count: (\d+)/.exec(git(d, ["count-objects", "-v"]).toString())?.[1]);
const hashBlob = (d: string, text: string) =>
  execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: d, input: text }).toString().trim();
/** a commit no ref reaches */
const danglingCommit = (d: string, msg: string) => {
  const tree = rev(d, "HEAD^{tree}");
  return execFileSync("git", ["commit-tree", tree, "-p", "HEAD", "-m", msg], { cwd: d })
    .toString()
    .trim();
};

/** A bare repository with history, a rewritten branch (unreachable commits, packed and loose) and dangling blobs. */
function messyBare() {
  const src = repoWithHistory(15);
  git(src, ["checkout", "-q", "-b", "side"]);
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(src, "side.txt"), `side ${i}\n`);
    git(src, ["add", "-A"]);
    git(src, ["commit", "-q", "-m", `side ${i}`]);
  }
  git(src, ["checkout", "-q", "main"]);
  const bare = join(tmp(), "repo.git");
  git(tmpdir(), ["clone", "-q", "--bare", "--no-local", src, bare]);
  // the side branch is dropped: its commits, packed, become unreachable
  const sideTip = rev(bare, "refs/heads/side");
  git(bare, ["update-ref", "-d", "refs/heads/side"]);
  // main rewound by two commits
  git(bare, ["update-ref", "refs/heads/main", "refs/heads/main~2"]);
  // loose dangling objects
  for (let i = 0; i < 5; i++) hashBlob(bare, `dangling blob ${i}\n`);
  danglingCommit(bare, "dangling commit");
  return { src, bare, sideTip };
}

describe("R1 the result native git gc --prune=now keeps", () => {
  it("same object set, one pack, no loose objects, refs unchanged, fsck --strict, size", async () => {
    const { bare } = messyBare();
    const theirs = join(tmp(), "theirs.git");
    cpSync(bare, theirs, { recursive: true });
    git(theirs, ["gc", "-q", "--prune=now"]);
    const refsBefore = git(bare, ["for-each-ref"]).toString();
    const s = await gc(await openBare(bare), { graceMs: 0 });
    expect(s.done).toBe(true);
    expect(objectsOf(bare)).toEqual(objectsOf(theirs));
    expect(packsOf(bare).length).toBe(1);
    expect(looseCount(bare)).toBe(0);
    expect(git(bare, ["for-each-ref"]).toString()).toBe(refsBefore);
    git(bare, ["fsck", "--strict"]);
    const size = (d: string) => statSync(join(d, "objects", "pack", packsOf(d)[0] as string)).size;
    console.log(`R1: ours ${size(bare)} B, git ${size(theirs)} B; ${JSON.stringify(s.stats)}`);
    expect(size(bare)).toBeLessThanOrEqual(size(theirs) * 1.15);
  }, 120_000);
});

describe("R2 the grace period", () => {
  it("a first run records and keeps the unreachable; a run past the grace deletes them, not one made reachable again", async () => {
    const { bare, sideTip } = messyBare();
    const dangling = hashBlob(bare, "watched dangling\n");
    const back = danglingCommit(bare, "comes back");
    const t0 = Date.now();
    await gc(await openBare(bare), { graceMs: 10_000, now: () => t0 });
    expect(objectsOf(bare)).toContain(dangling);
    expect(objectsOf(bare)).toContain(back);
    expect(objectsOf(bare)).toContain(sideTip); // packed and unreachable, still young: its pack stays
    git(bare, ["update-ref", "refs/heads/back", back]);
    await gc(await openBare(bare), { graceMs: 10_000, now: () => t0 + 5_000 });
    expect(objectsOf(bare)).toContain(dangling); // not yet: 5 s of 10
    await gc(await openBare(bare), { graceMs: 10_000, now: () => t0 + 11_000 });
    expect(objectsOf(bare)).not.toContain(dangling);
    expect(objectsOf(bare)).not.toContain(sideTip);
    expect(objectsOf(bare)).toContain(back);
    expect(packsOf(bare).length).toBe(1);
    git(bare, ["fsck", "--strict"]);
  }, 120_000);
});

describe("R3 roots", () => {
  it("refs/peers, a detached HEAD, a reflog entry and an annotated tag keep their objects", async () => {
    const { bare } = messyBare();
    git(bare, ["config", "core.logAllRefUpdates", "always"]);
    const peer = danglingCommit(bare, "peer work");
    git(bare, ["update-ref", "refs/peers/p1/main", peer]);
    const detached = danglingCommit(bare, "detached");
    const viaReflog = danglingCommit(bare, "only in a reflog");
    git(bare, ["update-ref", "refs/heads/moving", viaReflog]);
    git(bare, ["update-ref", "refs/heads/moving", "refs/heads/main"]); // viaReflog stays in the reflog
    const tagged = danglingCommit(bare, "tagged");
    git(bare, ["tag", "-a", "t1", "-m", "t1", tagged]);
    git(bare, ["update-ref", "--no-deref", "HEAD", detached]);
    await gc(await openBare(bare), { graceMs: 0 });
    const objs = objectsOf(bare);
    for (const o of [peer, detached, viaReflog, tagged]) expect(objs).toContain(o);
    git(bare, ["fsck", "--strict"]);
  }, 120_000);
});

describe("R4 concurrent writers", () => {
  it("objects and ref moves during every phase, a resurrected commit after the mark: nothing reachable lost", async () => {
    const { bare } = messyBare();
    const old = danglingCommit(bare, "old, unreachable at the start");
    const work = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", bare, work]);
    let n = 0;
    await gc(await openBare(bare), {
      graceMs: 0,
      afterPhase: async (phase) => {
        writeFileSync(join(work, `during-${phase}.txt`), `written during ${phase}\n`);
        git(work, ["add", "-A"]);
        git(work, ["commit", "-q", "-m", `during ${phase}`]);
        git(work, ["push", "-q", "origin", `HEAD:refs/heads/during-${n++}`]);
        if (phase === "mark") git(bare, ["update-ref", "refs/heads/resurrected", old]);
      },
    });
    expect(objectsOf(bare)).toContain(old);
    git(bare, ["fsck", "--strict"]);
    for (let i = 0; i < n; i++)
      expect(rev(bare, `refs/heads/during-${i}`)).toMatch(/^[0-9a-f]{40}$/);
  }, 120_000);
});

describe("R5 leases", () => {
  it("a live lease defers the sweep; a writer arriving during a sweep waits for it", async () => {
    const { bare } = messyBare();
    const dangling = hashBlob(bare, "leased era\n");
    const repo = await openBare(bare);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const lease = withLease(repo, () => held);
    await new Promise((r) => setTimeout(r, 50));
    const s1 = await gc(repo, { graceMs: 0 });
    expect(s1.deferred).toBe(true);
    expect(objectsOf(bare)).toContain(dangling);
    release();
    await lease;
    // a writer during the sweep: its body runs only after the sweep ends
    const events: string[] = [];
    let writer: Promise<void> | undefined;
    const s2 = await gc(await openBare(bare), {
      graceMs: 0,
      duringSweep: async () => {
        writer = withLease(repo, async () => {
          events.push("writer");
        });
        await new Promise((r) => setTimeout(r, 200));
        events.push("sweep still running");
      },
    });
    events.push("sweep done");
    await writer;
    expect(s2.done).toBe(true);
    expect(events.indexOf("writer")).toBeGreaterThan(events.indexOf("sweep still running"));
    expect(objectsOf(bare)).not.toContain(dangling);
  }, 120_000);
});

describe("R6 resumable", () => {
  it("one phase per step with a fresh handle, and a crash after each phase: the one-shot result", async () => {
    const { bare } = messyBare();
    const oneShot = join(tmp(), "one.git");
    cpSync(bare, oneShot, { recursive: true });
    await gc(await openBare(oneShot), { graceMs: 0 });
    const expected = objectsOf(oneShot);
    // stepwise, a fresh handle per step
    const stepped = join(tmp(), "step.git");
    cpSync(bare, stepped, { recursive: true });
    let steps = 0;
    for (;;) {
      const s = await gcStep(await openBare(stepped), { graceMs: 0, units: 1 });
      steps++;
      if (s.done) break;
      if (steps > 20) throw new Error("no progress");
    }
    expect(steps).toBeGreaterThanOrEqual(5);
    expect(objectsOf(stepped)).toEqual(expected);
    // a crash after each phase, then resumed
    for (const crashAt of ["snapshot", "mark", "repack", "ledger", "sweep"] as const) {
      const d = join(tmp(), `crash-${crashAt}.git`);
      cpSync(bare, d, { recursive: true });
      await expect(
        gc(await openBare(d), {
          graceMs: 0,
          afterPhase: async (p) => {
            if (p === crashAt) throw new Error(`crash after ${p}`);
          },
        }),
      ).rejects.toThrow(/crash/);
      const s = await gc(await openBare(d), { graceMs: 0 });
      expect(s.done, crashAt).toBe(true);
      expect(objectsOf(d), crashAt).toEqual(expected);
      git(d, ["fsck", "--strict"]);
    }
  }, 300_000);
});

describe("R7 SQL backend", () => {
  it("loose rows and several packs → one pack; unreachable rows removed; the log reads the same", async () => {
    const src = repoWithHistory(10);
    const repo: Repository = await sqlRepository(await newNodeSqliteDb());
    const pack1 = git(src, ["pack-objects", "--stdout", "-q", "--revs"], "HEAD~5\n");
    const pack2 = git(src, ["pack-objects", "--stdout", "-q", "--revs"], "HEAD\n^HEAD~5\n");
    for (const p of [pack1, pack2])
      await repo.objects.installPack(
        (async function* () {
          yield new Uint8Array(p);
        })(),
      );
    await repo.refs.batch([{ name: "refs/heads/main", new: rev(src, "HEAD") }]);
    await repo.refs.setSymref("HEAD", "refs/heads/main");
    // loose rows: a new commit on main, and a dangling blob
    const tree = await writeFiles(repo, { "new.txt": new TextEncoder().encode("loose\n") });
    const who = { name: "x", email: "x@x", when: 1800000000, tz: "+0000" };
    await commit(repo, {
      ref: "refs/heads/main",
      tree,
      parents: [rev(src, "HEAD")],
      author: who,
      message: "loose commit\n",
    });
    const dangling = await repo.objects.put("blob", new TextEncoder().encode("dangling row\n"));
    const before = await log(repo, "HEAD");
    const s = await gc(repo, { graceMs: 0 });
    expect(s.done).toBe(true);
    const access = repo.objects.gc;
    expect(access).toBeDefined();
    expect(access?.packs().length).toBe(1);
    let loose = 0;
    for await (const _ of access?.loose() ?? []) loose++;
    expect(loose).toBe(0);
    expect(await repo.objects.has(dangling)).toBe(false);
    expect(await log(repo, "HEAD")).toEqual(before);
  }, 120_000);
});
