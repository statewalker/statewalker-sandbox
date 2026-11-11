import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, gitEnv, noise, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { gc as rawGc } from "../../24-gc/src/gc.js";
import { openRepository, toVcsError, type Vcs, VcsError } from "../src/vcs.js";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x16b-"));
  dirs.push(d);
  return d;
};
const enc = new TextEncoder();
const rev = (d: string, r: string) => git(d, ["rev-parse", r]).toString().trim();
const filesSpec = (gitDir: string) => ({
  files: new StreamingNodeFilesApi(gitDir),
  refFiles: nodeRefFiles(gitDir),
});
const who = { name: "Ada", email: "ada@example.com", when: 1800000000, tz: "+0000" };
const gitAsync = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...gitEnv, NO_PROXY: "127.0.0.1" } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString())
        : reject(new Error(`git ${args.join(" ")}: ${Buffer.concat(err).toString()}`)),
    );
  });
/** Serves a fetch handler on 127.0.0.1 (no keep-alive). */
async function serve(handler: (req: Request) => Promise<Response>): Promise<string> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
      const response = await handler(
        new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers,
          body: req.method === "GET" ? undefined : Buffer.concat(chunks),
        }),
      );
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        connection: "close",
      });
      if (response.body)
        for await (const c of response.body as unknown as AsyncIterable<Uint8Array>) res.write(c);
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
}
async function expectCode(p: Promise<unknown>, code: string) {
  const e = await p.then(
    () => undefined,
    (x) => x,
  );
  expect(e, `expected ${code}`).toBeInstanceOf(VcsError);
  expect((e as VcsError).code).toBe(code);
}

describe("R1 open and init", () => {
  it("a new git-files repository is what git init --bare makes; a new SQL repository has the same HEAD; reopening finds both", async () => {
    const d = join(tmp(), "new.git");
    mkdirSync(d);
    const v = await openRepository(filesSpec(d), { init: true, identity: who });
    expect(git(d, ["rev-parse", "--is-bare-repository"]).toString().trim()).toBe("true");
    expect(git(d, ["symbolic-ref", "HEAD"]).toString().trim()).toBe("refs/heads/main");
    expect(git(d, ["config", "--get", "core.repositoryformatversion"]).toString().trim()).toBe("0");
    const c = await v.commit({ files: { "a.txt": enc.encode("a\n") }, message: "first\n" });
    expect(rev(d, "refs/heads/main")).toBe(c);
    git(d, ["fsck", "--strict"]);
    const again = await openRepository(filesSpec(d));
    expect(await again.log("HEAD")).toEqual([c]);
    // SQL
    const db = await newNodeSqliteDb();
    const s = await openRepository({ db }, { init: true, defaultBranch: "trunk", identity: who });
    expect(await s.repo.refs.read("HEAD")).toEqual({ symref: "refs/heads/trunk" });
    const sc = await s.commit({ files: { "b.txt": enc.encode("b\n") }, message: "sql\n" });
    expect(await (await openRepository({ db })).log("HEAD")).toEqual([sc]);
  });
});

describe("R2 config", () => {
  it("git's format kept byte for byte around an edit; identity from user.name/user.email", async () => {
    const d = join(tmp(), "cfg.git");
    git(tmpdir(), ["init", "-q", "--bare", d]);
    const original = `${readFileSync(join(d, "config"), "utf8")}; a comment kept\n[remote "origin"]\n\turl = https://example.com/x.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[alias]\n\tlg = "log --oneline # not a comment"\n`;
    writeFileSync(join(d, "config"), original);
    const v = await openRepository(filesSpec(d));
    expect(v.config.get("remote.origin.url")).toBe("https://example.com/x.git");
    expect(v.config.get("alias.lg")).toBe("log --oneline # not a comment");
    expect(v.config.get("core.bare")).toBe("true");
    await v.config.set("user.name", "Grace Hopper");
    await v.config.set("user.email", "grace@example.com");
    await v.config.set("remote.origin.url", "https://example.com/y.git");
    const text = readFileSync(join(d, "config"), "utf8");
    expect(text).toContain("; a comment kept\n");
    expect(text).toContain('\tlg = "log --oneline # not a comment"\n');
    expect(git(d, ["config", "--get", "user.name"]).toString().trim()).toBe("Grace Hopper");
    expect(git(d, ["config", "--get", "remote.origin.url"]).toString().trim()).toBe(
      "https://example.com/y.git",
    );
    const c = await v.commit({
      ref: "refs/heads/main",
      files: { "x.txt": enc.encode("x\n") },
      message: "cfg\n",
    });
    expect(git(d, ["log", "-1", "--format=%an <%ae>", c]).toString().trim()).toBe(
      "Grace Hopper <grace@example.com>",
    );
  });
});

describe("R3 error codes", () => {
  it("every class of failure carries a code", async () => {
    const src = repoWithHistory(3);
    const v = await openRepository(filesSpec(join(src, ".git")));
    const h = rev(src, "HEAD");
    // CONFLICT: a stale old value
    await expectCode(
      v.updateRefs([{ name: "refs/heads/main", old: rev(src, "HEAD~1"), new: h }]),
      "CONFLICT",
    );
    // INVALID: a bad ref name
    await expectCode(v.updateRefs([{ name: "refs/heads/a..b", new: h }]), "INVALID");
    // LOCKED: a ref lock held
    writeFileSync(join(src, ".git", "refs", "heads", "main.lock"), "");
    await expectCode(
      v.updateRefs([{ name: "refs/heads/main", new: rev(src, "HEAD~1") }]),
      "LOCKED",
    );
    rmSync(join(src, ".git", "refs", "heads", "main.lock"));
    // NOT_FOUND: committing onto a parent that does not exist
    await expectCode(
      v.commit({ files: {}, parents: ["1".repeat(40)], message: "x\n", author: who }),
      "NOT_FOUND",
    );
    // CORRUPT: a corrupt pack
    const pack = new Uint8Array(git(src, ["pack-objects", "--stdout", "-q", "--revs"], "HEAD\n"));
    pack[pack.length >> 1] = (pack[pack.length >> 1] as number) ^ 0xff;
    await expectCode(
      v.installPack(
        (async function* () {
          yield pack;
        })(),
      ),
      "CORRUPT",
    );
    // LIMIT: a pack over the store's limit
    const small = await openRepository(filesSpec(join(src, ".git")), { maxPackSize: 100 });
    await expectCode(
      small.installPack(
        (async function* () {
          yield new Uint8Array(git(src, ["pack-objects", "--stdout", "-q", "--revs"], "HEAD\n"));
        })(),
      ),
      "LIMIT",
    );
    // PROTOCOL: a server speaking nonsense
    const bad = await serve(async () => new Response("this is not git", { status: 200 }));
    await expectCode(v.fetch(bad), "PROTOCOL");
    // ABORTED
    const ac = new AbortController();
    ac.abort();
    await expectCode(v.gc({ graceMs: 0, signal: ac.signal }), "ABORTED");
    // UNSUPPORTED: a shallow fetch from a server without shallow (an advertisement lacking it)
    expect(toVcsError(new Error("the server does not support shallow fetches")).code).toBe(
      "UNSUPPORTED",
    );
    // any other error still gets a code (a VcsError is returned as is)
    expect(toVcsError(new VcsError("LOCKED", "x")).code).toBe("LOCKED");
  });
});

describe("R4 cancellation within 100 ms, no partial state", () => {
  /** runs `op` with a signal aborted after `after` ms; returns the time from abort to rejection */
  async function abortAfter(op: (s: AbortSignal) => Promise<unknown>, after: number) {
    const ac = new AbortController();
    const p = op(ac.signal).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, e }),
    );
    await new Promise((r) => setTimeout(r, after));
    const t0 = performance.now();
    ac.abort();
    const r = await p;
    return { ...r, ms: performance.now() - t0 };
  }
  it("installPack, fetch, push, gc", async () => {
    const src = repoWithHistory(3);
    const dir = join(src, ".git");
    const v = await openRepository(filesSpec(dir), { identity: who });
    const refsBefore = git(src, ["for-each-ref"]).toString();
    // installPack from a slow source
    const pack = new Uint8Array(git(src, ["pack-objects", "--stdout", "-q", "--revs"], "HEAD\n"));
    const slow = (signal?: AbortSignal) =>
      (async function* () {
        for (let i = 0; i < pack.length; i += 64) {
          await new Promise((r) => setTimeout(r, 50));
          signal?.throwIfAborted();
          yield pack.subarray(i, i + 64);
        }
      })();
    let r = await abortAfter((s) => v.installPack(slow(), { signal: s }), 200);
    expect(r.ok).toBe(false);
    expect(toVcsError((r as { e: unknown }).e).code).toBe("ABORTED");
    expect(r.ms).toBeLessThan(100);
    // fetch from a slow server
    const stall = await serve(async (req) => {
      await new Promise((x) => setTimeout(x, 5000));
      void req;
      return new Response("late");
    });
    r = await abortAfter((s) => v.fetch(stall, { signal: s }), 100);
    expect(toVcsError((r as { e: unknown }).e).code).toBe("ABORTED");
    expect(r.ms).toBeLessThan(100);
    // push to a slow server
    r = await abortAfter((s) => v.push(stall, { refspecs: ["HEAD:refs/heads/x"], signal: s }), 100);
    expect(toVcsError((r as { e: unknown }).e).code).toBe("ABORTED");
    expect(r.ms).toBeLessThan(100);
    // gc of a larger repository, aborted mid-way
    const big = join(tmp(), "big");
    git(tmpdir(), ["init", "-q", big]);
    for (let i = 0; i < 40; i++) writeFileSync(join(big, `f${i}.bin`), noise(256 * 1024, i + 1));
    git(big, ["add", "-A"]);
    git(big, ["commit", "-q", "-m", "blobs"]);
    const vb = await openRepository(filesSpec(join(big, ".git")));
    r = await abortAfter((s) => vb.gc({ graceMs: 0, signal: s }), 150);
    expect(toVcsError((r as { e: unknown }).e).code).toBe("ABORTED");
    expect(r.ms).toBeLessThan(100);
    // a later gc completes; nothing was lost
    await vb.gc({ graceMs: 0 });
    git(big, ["fsck", "--strict"]);
    expect(git(src, ["for-each-ref"]).toString()).toBe(refsBefore);
  }, 120_000);
});

describe("R5 hooks", () => {
  it("reference-transaction on commit, fetch and received pushes; commit hooks; refusals change nothing", async () => {
    const events: string[] = [];
    let refuse: string | undefined;
    const d = join(tmp(), "h.git");
    mkdirSync(d);
    const v = await openRepository(filesSpec(d), {
      init: true,
      identity: who,
      hooks: {
        referenceTransaction: async (state, updates) => {
          events.push(`${state}:${updates.map((u) => u.name).join(",")}`);
          return state === "prepared" ? refuse : undefined;
        },
        preCommit: async () => (refuse === "pre-commit" ? "no commits now" : undefined),
        commitMsg: async (m) => `${m.trim()}\n\nSigned-off-by: hook\n`,
        postCommit: async (oid) => {
          events.push(`post-commit:${oid.slice(0, 7)}`);
        },
      },
    });
    const c = await v.commit({ files: { "a.txt": enc.encode("a\n") }, message: "one\n" });
    expect(events).toEqual([
      "prepared:refs/heads/main",
      "committed:refs/heads/main",
      `post-commit:${c.slice(0, 7)}`,
    ]);
    expect(git(d, ["log", "-1", "--format=%B", c]).toString()).toContain("Signed-off-by: hook");
    // a refused transaction: CONFLICT, nothing changes, "aborted" told
    events.length = 0;
    refuse = "frozen";
    await expectCode(
      v.commit({ files: { "b.txt": enc.encode("b\n") }, message: "two\n" }),
      "CONFLICT",
    );
    expect(rev(d, "refs/heads/main")).toBe(c);
    expect(events).toEqual(["prepared:refs/heads/main", "aborted:refs/heads/main"]);
    refuse = "pre-commit";
    await expectCode(
      v.commit({ files: { "b.txt": enc.encode("b\n") }, message: "two\n" }),
      "CONFLICT",
    );
    expect(rev(d, "refs/heads/main")).toBe(c);
    refuse = undefined;
    // fetch updates refs through the hooks
    const src = repoWithHistory(3);
    const srcUrl = await serve((await openRepository(filesSpec(join(src, ".git")))).serve());
    events.length = 0;
    await v.fetch(srcUrl, { refspecs: ["+refs/heads/main:refs/remotes/src/main"] });
    expect(events).toEqual(["prepared:refs/remotes/src/main", "committed:refs/remotes/src/main"]);
    // a received push too (the served repository's hooks)
    const url = await serve(v.serve());
    const work = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", d, work]);
    writeFileSync(join(work, "c.txt"), "c\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "pushed"]);
    events.length = 0;
    await gitAsync(work, ["push", "-q", url, "HEAD:refs/heads/pushed"]);
    expect(events).toEqual(["prepared:refs/heads/pushed", "committed:refs/heads/pushed"]);
    refuse = "no pushes";
    await expect(gitAsync(work, ["push", "-q", url, "HEAD:refs/heads/refused"])).rejects.toThrow();
    expect(() => rev(d, "refs/heads/refused")).toThrow();
  }, 120_000);
});

describe("R6 leases on writers", () => {
  it("a commit and a received push hold gc's lease until their ref update: a gc meanwhile defers", async () => {
    const d = join(tmp(), "l.git");
    mkdirSync(d);
    const results: string[] = [];
    let during: (() => Promise<void>) | undefined;
    const v: Vcs = await openRepository(filesSpec(d), {
      init: true,
      identity: who,
      hooks: {
        referenceTransaction: async (state) => {
          if (state === "prepared" && during) await during();
          return undefined;
        },
      },
    });
    await v.commit({ files: { "base.txt": enc.encode("base\n") }, message: "base\n" });
    during = async () => {
      const s = await rawGc(await openRepository(filesSpec(d)).then((x) => x.repo), { graceMs: 0 });
      results.push(s.deferred ? "deferred" : "ran");
    };
    const c = await v.commit({ files: { "new.txt": enc.encode("new\n") }, message: "leased\n" });
    expect(results).toEqual(["deferred"]);
    git(d, ["cat-file", "-t", c]);
    // a received push
    const url = await serve(v.serve());
    const work = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", d, work]);
    writeFileSync(join(work, "p.txt"), "pushed\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "pushed"]);
    results.length = 0;
    await gitAsync(work, ["push", "-q", url, "HEAD:refs/heads/p"]);
    expect(results).toEqual(["deferred"]);
    during = undefined;
    git(d, ["fsck", "--strict"]);
  }, 120_000);
});

describe("R7 inside a Durable Object", () => {
  it("open (init), commit, log, gc in workerd", async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../src/do-entry.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    const mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-07-01",
      durableObjects: { REPO: { className: "FacadeDo", useSQLite: true } },
    });
    try {
      const r = (await (await mf.dispatchFetch("http://x/run", { method: "POST" })).json()) as {
        error?: string;
        log?: string[];
        gc?: string;
        head?: unknown;
      };
      expect(r.error).toBeUndefined();
      expect(r.log?.length).toBe(3);
      expect(r.gc).toBe("done");
      expect(r.head).toEqual({ symref: "refs/heads/main" });
    } finally {
      await mf.dispose();
    }
  }, 120_000);
});
void execFileSync;
