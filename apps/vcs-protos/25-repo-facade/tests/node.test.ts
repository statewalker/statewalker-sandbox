import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { filesRepository } from "../../17-repository/src/repository.js";
import { acquireLease, gc as rawGc } from "../../24-gc/src/gc.js";
import { GitConfig } from "../src/config.js";
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
    expect(git(d, ["config", "--get", "core.bare"]).toString().trim()).toBe("true");
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
    // an edit replaces the value, it does not add a second one
    expect(git(d, ["config", "--get-all", "remote.origin.url"]).toString()).toBe(
      "https://example.com/y.git\n",
    );
    expect(v.config.getAll("remote.origin.url")).toEqual(["https://example.com/y.git"]);
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
          return state === "prepared" && refuse !== "pre-commit" ? refuse : undefined;
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
    events.length = 0;
    await expectCode(
      v.commit({ files: { "b.txt": enc.encode("b\n") }, message: "two\n" }),
      "CONFLICT",
    );
    expect(rev(d, "refs/heads/main")).toBe(c);
    expect(events).toEqual([]); // refused before any ref transaction
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
        reachable?: number;
        head?: unknown;
      };
      expect(r.error).toBeUndefined();
      expect(r.log?.length).toBe(3);
      expect(r.gc).toBe("done");
      expect(r.reachable).toBeGreaterThanOrEqual(9); // 3 commits, 3 trees, 3 blobs
      expect(r.head).toEqual({ symref: "refs/heads/main" });
    } finally {
      await mf.dispose();
    }
  }, 120_000);
});
void execFileSync;

// ---- review of #88: each test reproduces one finding ----
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const leaseFiles = (d: string) =>
  existsSync(join(d, "gc", "leases")) ? readdirSync(join(d, "gc", "leases")) : [];

describe("review #88", () => {
  it("F1 an aborted fetch changes no ref afterwards", async () => {
    const src = repoWithHistory(3);
    git(src, ["branch", "b2", "HEAD~1"]);
    const handler = (await openRepository(filesSpec(join(src, ".git")))).serve();
    const f = ((input: RequestInfo | URL, init?: RequestInit) =>
      handler(new Request(input, init))) as typeof fetch;
    const d = join(tmp(), "f.git");
    mkdirSync(d);
    const v = await openRepository(filesSpec(d), {
      init: true,
      hooks: {
        referenceTransaction: async (s) => {
          if (s === "prepared") await sleep(150);
          return undefined;
        },
      },
    });
    const ac = new AbortController();
    const p = v.fetch("http://x/repo.git", {
      refspecs: ["+refs/heads/*:refs/remotes/o/*"],
      signal: ac.signal,
      fetch: f,
    });
    await sleep(100);
    const t0 = performance.now();
    ac.abort();
    await expectCode(p, "ABORTED");
    expect(performance.now() - t0).toBeLessThan(100);
    await sleep(600);
    expect(git(d, ["for-each-ref", "--format=%(refname)"]).toString()).toBe("");
  });

  it("F2 an update through a symbolic ref reports (and is refused for) its target", async () => {
    const d = join(tmp(), "sym.git");
    mkdirSync(d);
    const events: string[] = [];
    let guard = false;
    const v = await openRepository(filesSpec(d), {
      init: true,
      identity: who,
      hooks: {
        referenceTransaction: async (state, updates) => {
          events.push(`${state}:${updates.map((u) => u.name).join(",")}`);
          return guard && state === "prepared" && updates.some((u) => u.name === "refs/heads/main")
            ? "main is frozen"
            : undefined;
        },
      },
    });
    const c = await v.commit({ files: { a: enc.encode("a") }, message: "a\n" });
    expect(events).toEqual(["prepared:refs/heads/main", "committed:refs/heads/main"]);
    const c2 = await v.commit({
      ref: "refs/heads/x",
      files: { a: enc.encode("b") },
      message: "b\n",
    });
    guard = true;
    events.length = 0;
    await expectCode(v.updateRefs([{ name: "HEAD", new: c2 }]), "CONFLICT");
    expect(rev(d, "refs/heads/main")).toBe(c);
    // git reports the named ref and its target (verified against git 2.43)
    expect(events).toEqual(["prepared:HEAD,refs/heads/main", "aborted:HEAD,refs/heads/main"]);
  });

  it("F3 F5 F6 F7 F8 F16 config edge cases, as git", async () => {
    // F3 a key on the header line keeps its section
    let c = new GitConfig("[core]\n\tbare = true\n[user] name = a\n\temail = e@x\n");
    c.set("user.name", "b");
    expect(c.get("user.name")).toBe("b");
    expect(c.get("user.email")).toBe("e@x");
    expect(c.get("core.name")).toBeUndefined();
    expect(c.text()).toBe("[core]\n\tbare = true\n[user]\n\tname = b\n\temail = e@x\n");
    // F5 an escaped backslash or a comment ending in one does not continue the line
    c = new GitConfig("[a]\n\tk = C:\\\\\n\tj = 1\n\tl = x # c \\\n\tm = 2\n");
    expect(c.get("a.k")).toBe("C:\\");
    expect(c.get("a.j")).toBe("1");
    expect(c.get("a.l")).toBe("x");
    expect(c.get("a.m")).toBe("2");
    // a real continuation
    c = new GitConfig("[a]\n\tk = one \\\n two\n");
    expect(c.get("a.k")).toBe("one  two");
    // F6 CRLF files
    c = new GitConfig('[a]\r\n\tk = "q"\r\n\tj = 1\r\n');
    expect(c.get("a.k")).toBe("q");
    expect(c.get("a.j")).toBe("1");
    expect(() => c.set("a.k", "x\ry")).toThrow();
    c = new GitConfig("[a]\r\n\tk = one \\\r\n two\r\n\tj = 1\r\n");
    expect(c.get("a.k")).toBe("one  two");
    expect(c.get("a.j")).toBe("1");
    // F7 names git rejects
    for (const k of ["user.full name", "a_b.k", "a.1k", "nodot"])
      expect(() => new GitConfig("").set(k, "x"), k).toThrow(/invalid key/);
    expect(() => new GitConfig("").set("a.s\nx.k", "x")).toThrow(/invalid key/);
    // F8 one value cannot overwrite several
    c = new GitConfig("[a]\n\tk = 1\n\tk = 2\n");
    expect(() => c.set("a.k", "3")).toThrow(/multiple values/);
    expect(c.getAll("a.k")).toEqual(["1", "2"]);
    // F16 unquoted whitespace is one space each; quoted kept; a new key after the last key
    c = new GitConfig('[a]\n\tk = x\t\ty\n\tq = "x\t\ty"\n\t# trailing comment\n\n[b]\n');
    expect(c.get("a.k")).toBe("x  y");
    expect(c.get("a.q")).toBe("x\t\ty");
    c.set("a.n", "1");
    expect(c.text()).toBe(
      '[a]\n\tk = x\t\ty\n\tq = "x\t\ty"\n\tn = 1\n\t# trailing comment\n\n[b]\n',
    );
    // what we write, git reads back identically
    const d = join(tmp(), "cfg2.git");
    git(tmpdir(), ["init", "-q", "--bare", d]);
    const w = new GitConfig(readFileSync(join(d, "config"), "utf8"));
    for (const [k, val] of [
      ["x.y", 'a "quoted" \\ back'],
      ["x.tab", "a\tb"],
      ["x.nl", "a\nb"],
      ["x.bs", "a\bb"],
      ["x.lead", "  spaced "],
      ['r.s "q\\.k', "v"],
    ] as const)
      w.set(k, val);
    writeFileSync(join(d, "config"), w.text());
    for (const k of ["x.y", "x.tab", "x.nl", "x.bs", "x.lead"])
      expect(
        execFileSync("git", ["config", "--get", k], { cwd: d, env: gitEnv }).toString(),
        k,
      ).toBe(`${w.get(k)}\n`);
  });

  it("F4 config edits re-read the file and respect git's lock", async () => {
    const d = join(tmp(), "cfg3.git");
    git(tmpdir(), ["init", "-q", "--bare", d]);
    const v = await openRepository(filesSpec(d));
    git(d, ["config", "user.email", "set-by-git@example.com"]);
    await v.config.set("user.name", "Grace");
    expect(git(d, ["config", "--get", "user.email"]).toString().trim()).toBe(
      "set-by-git@example.com",
    );
    expect(v.config.get("user.email")).toBe("set-by-git@example.com");
    writeFileSync(join(d, "config.lock"), "");
    await expectCode(v.config.set("user.name", "X"), "LOCKED");
    expect(git(d, ["config", "--get", "user.name"]).toString().trim()).toBe("Grace");
  });

  it("F9 hooks after the update cannot fail the commit; a refusing commit-msg is CONFLICT", async () => {
    const d = join(tmp(), "h9.git");
    mkdirSync(d);
    let mode = "";
    const events: string[] = [];
    const v = await openRepository(filesSpec(d), {
      init: true,
      identity: who,
      hooks: {
        referenceTransaction: async (state) => {
          events.push(state);
          if (state === "prepared" && mode === "prepared-throws") throw new Error("hook crashed");
          if (state === "committed" && mode === "committed-throws") throw new Error("late");
          return undefined;
        },
        commitMsg: async (m) => {
          if (mode === "msg") throw new Error("bad message");
          return m;
        },
        postCommit: async () => {
          if (mode === "post") throw new Error("post-commit failed");
        },
      },
    });
    mode = "post";
    const c1 = await v.commit({ files: { a: enc.encode("1") }, message: "1\n" });
    expect(rev(d, "refs/heads/main")).toBe(c1);
    mode = "committed-throws";
    const c2 = await v.commit({ files: { a: enc.encode("2") }, message: "2\n" });
    expect(rev(d, "refs/heads/main")).toBe(c2);
    mode = "msg";
    await expectCode(v.commit({ files: { a: enc.encode("3") }, message: "3\n" }), "CONFLICT");
    mode = "prepared-throws";
    events.length = 0;
    await expectCode(v.commit({ files: { a: enc.encode("3") }, message: "3\n" }), "CONFLICT");
    expect(events).toEqual(["prepared", "aborted"]);
    expect(rev(d, "refs/heads/main")).toBe(c2);
  });

  it("F10 a commit on a detached HEAD moves HEAD, not the default branch", async () => {
    const d = join(tmp(), "det.git");
    mkdirSync(d);
    const v = await openRepository(filesSpec(d), { init: true, identity: who });
    const c1 = await v.commit({ files: { a: enc.encode("1") }, message: "1\n" });
    const c2 = await v.commit({ files: { a: enc.encode("2") }, message: "2\n" });
    git(d, ["update-ref", "--no-deref", "HEAD", c1]);
    const c3 = await v.commit({ files: { a: enc.encode("3") }, message: "3\n" });
    expect(rev(d, "HEAD")).toBe(c3);
    expect(rev(d, `${c3}^`)).toBe(c1);
    expect(rev(d, "refs/heads/main")).toBe(c2);
  });

  it("F11 an abort with any reason is ABORTED", async () => {
    const d = join(tmp(), "ab.git");
    mkdirSync(d);
    const v = await openRepository(filesSpec(d), { init: true });
    for (const reason of ["user pressed stop", new Error("navigation"), undefined]) {
      const ac = new AbortController();
      const p = v.installPack(
        (async function* () {
          await sleep(1000);
          yield new Uint8Array(1);
        })(),
        { signal: ac.signal },
      );
      setTimeout(() => ac.abort(reason), 10);
      await expectCode(p, "ABORTED");
      const ac2 = new AbortController();
      ac2.abort(reason);
      await expectCode(v.gc({ signal: ac2.signal }), "ABORTED");
    }
  });

  it("F12 the layers' errors map to their codes", () => {
    const named = (name: string, message: string) => Object.assign(new Error(message), { name });
    const cases: [unknown, string][] = [
      [named("CorruptObjectError", "abc: truncated zlib stream"), "CORRUPT"],
      [named("CorruptObjectError", "bad object header"), "CORRUPT"],
      [named("CorruptObjectError", "object size too large: 99"), "CORRUPT"],
      [new Error(`object ${"a".repeat(40)} hashed to ${"b".repeat(40)}`), "CORRUPT"],
      [new Error("blob id mismatch: supplied x computed y"), "CORRUPT"],
      [new Error("http://h/abort-test.git: HTTP 500"), "PROTOCOL"],
      [new Error("http://h/abortive.git does not speak protocol v2"), "PROTOCOL"],
      [new Error("http://h/lockdown.git: HTTP 503"), "PROTOCOL"],
      [new TypeError("fetch failed"), "PROTOCOL"],
      [new Error("http://h/corrupt.git does not speak protocol v2"), "PROTOCOL"],
      [new Error("the server does not offer fetch"), "PROTOCOL"],
      [new Error(`no object ${"c".repeat(40)}`), "NOT_FOUND"],
      [new Error("refs/heads/main.lock exists"), "LOCKED"],
      [named("AbortError", "x"), "ABORTED"],
    ];
    for (const [e, code] of cases) expect(toVcsError(e).code, String(e)).toBe(code);
  });

  it("F13 a released lease stays released when a renewal was in flight", async () => {
    const d = join(tmp(), "l.git");
    mkdirSync(d);
    await openRepository(filesSpec(d), { init: true });
    class Slow extends StreamingNodeFilesApi {
      override async write(path: string, content: Parameters<StreamingNodeFilesApi["write"]>[1]) {
        if (path.includes("leases")) await sleep(40);
        return super.write(path, content);
      }
    }
    const repo = await filesRepository(new Slow(d) as never, nodeRefFiles(d));
    const lease = await acquireLease(repo, { ttlMs: 60 }); // renewed every 20 ms
    await sleep(30);
    await lease.release();
    await sleep(120);
    expect(leaseFiles(d)).toEqual([]);
  });

  it("F14 a received push whose client went away releases its lease", async () => {
    const d = join(tmp(), "s.git");
    mkdirSync(d);
    const v = await openRepository(filesSpec(d), { init: true, identity: who });
    const c = await v.commit({ files: { a: enc.encode("1") }, message: "1\n" });
    const ac = new AbortController();
    const line = `${c} ${"0".repeat(40)} refs/heads/main\0report-status delete-refs\n`;
    const pkt = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
    const res = await v.serve()(
      new Request("http://x/repo.git/git-receive-pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-receive-pack-request" },
        body: pkt,
        signal: ac.signal,
      }),
    );
    expect(res.status).toBe(200);
    ac.abort(); // the response is never read
    await sleep(50);
    expect(leaseFiles(d)).toEqual([]);
  });

  it("F16 init makes git's description and info/exclude", async () => {
    const d = join(tmp(), "i.git");
    mkdirSync(d);
    await openRepository(filesSpec(d), { init: true });
    const ref = join(tmp(), "ref.git");
    git(tmpdir(), ["-c", "init.defaultBranch=main", "init", "-q", "--bare", ref]);
    for (const f of ["HEAD", "config", "description", "info/exclude"])
      expect(readFileSync(join(d, f), "utf8"), f).toBe(readFileSync(join(ref, f), "utf8"));
    expect(existsSync(join(d, "hooks"))).toBe(true);
  });
});
