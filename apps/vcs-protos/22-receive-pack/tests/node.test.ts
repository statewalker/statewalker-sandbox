import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, noise, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository, sqlRepository } from "../../17-repository/src/repository.js";
import { FLUSH, PktReader, pkt, readSideband, text } from "../../21-smart-http/src/pkt-line.js";
import { push } from "../src/client.js";
import { gitHandler, type PushCommand, receivePackHandler } from "../src/server.js";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x8b-"));
  dirs.push(d);
  return d;
};
const open = (dir: string) =>
  filesRepository(new StreamingNodeFilesApi(join(dir, ".git")), nodeRefFiles(join(dir, ".git")));
/** git without blocking the event loop (the server it talks to runs in this process). */
const gitAsync = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      },
    });
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
const rev = (d: string, r: string) => git(d, ["rev-parse", r]).toString().trim();
async function* chunksOf(bytes: Uint8Array, size: number) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const concat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/**
 * node:http's request as a web stream that tolerates an early cancel (a handler that stops reading
 * at its size limit): Readable.toWeb then throws "Controller is already closed".
 */
function requestBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      req.on("data", (c: Buffer) => {
        if (done) return;
        ctrl.enqueue(new Uint8Array(c));
        if ((ctrl.desiredSize ?? 1) <= 0) req.pause();
      });
      req.on("end", () => {
        if (!done) {
          done = true;
          ctrl.close();
        }
      });
      req.on("error", (e) => {
        if (!done) {
          done = true;
          ctrl.error(e);
        }
      });
    },
    pull() {
      req.resume();
    },
    cancel() {
      done = true;
      req.resume(); // drain: the response can still be written
    },
  });
}

/** Serves a fetch handler on 127.0.0.1 (the URL ends in /repo.git). */
async function serve(handler: (req: Request) => Promise<Response>): Promise<string> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : requestBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers,
        body,
        // @ts-expect-error node's fetch needs duplex for a streamed body
        duplex: "half",
      });
      const response = await handler(request);
      // no keep-alive: an idle socket closed by the server is never reused by the client (tests pause
      // between requests for many seconds)
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        connection: "close",
      });
      if (response.body) {
        const reader = response.body.getReader();
        res.on("close", () => void reader.cancel().catch(() => {}));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise((r) => res.once("drain", r));
        }
      }
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

/** `git http-backend` as CGI: the bare repository `dir` at /repo.git, pushes allowed. */
async function serveNative(dir: string): Promise<string> {
  git(dir, ["config", "http.receivepack", "true"]);
  const root = join(dir, "..");
  const name = dir.slice(root.length + 1);
  return serve(async (req) => {
    const u = new URL(req.url);
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: u.pathname.replace(/^\/repo\.git/, `/${name}`),
        QUERY_STRING: u.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers.get("content-type") ?? "",
        GIT_PROTOCOL: req.headers.get("git-protocol") ?? "",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    if (req.body) Readable.fromWeb(req.body as never).pipe(child.stdin);
    else child.stdin.end();
    const out: Buffer[] = [];
    for await (const c of child.stdout) out.push(c as Buffer);
    const all = Buffer.concat(out);
    const sep = all.indexOf("\r\n\r\n");
    const head = all.subarray(0, sep).toString().split("\r\n");
    const headers = new Headers();
    let status = 200;
    for (const h of head) {
      const i = h.indexOf(":");
      const k = h.slice(0, i).trim();
      const v = h.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
      else headers.set(k, v);
    }
    return new Response(all.subarray(sep + 4), { status, headers });
  });
}

const ZERO = "0".repeat(40);
const refsOf = (dir: string) =>
  git(dir, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"])
    .toString()
    .trim();
/** A bare copy of `src` (a native server, or a native client's remote). */
const bareCopy = (src: string) => {
  const d = join(tmp(), "bare.git");
  git(tmpdir(), ["clone", "-q", "--bare", src, d]);
  return d;
};
/** Our server holding `src`'s history: files (a bare copy) or SQL. */
async function ourServer(src: string, backend: "files" | "sql", opts = {}) {
  let repo: Repository;
  let dir: string | undefined;
  if (backend === "files") {
    dir = bareCopy(src);
    repo = await filesRepository(new StreamingNodeFilesApi(dir), nodeRefFiles(dir));
  } else {
    repo = await sqlRepository(await newNodeSqliteDb());
    const pack = git(src, ["pack-objects", "--stdout", "-q", "--all"], "");
    await repo.objects.installPack(chunksOf(new Uint8Array(pack), 65536));
    for (const l of refsOf(src).split("\n")) {
      const [oid, name] = l.split(" ") as [string, string];
      await repo.refs.batch([{ name, new: oid }]);
    }
    await repo.refs.setSymref("HEAD", "refs/heads/main");
  }
  return { repo, dir, url: await serve(gitHandler(repo, opts)) };
}
const refOf = async (repo: Repository, name: string) => (await repo.refs.resolve(name)) ?? ZERO;
const commitFile = (d: string, file: string, content: string, msg: string) => {
  writeFileSync(join(d, file), content);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", msg]);
};
/** A raw receive-pack request: commands (capabilities on the first), then a pack. */
function receiveRequest(
  commands: string[],
  pack?: Uint8Array,
  caps = "report-status side-band-64k",
) {
  const parts = commands.map((c, i) => pkt(i === 0 ? `${c}\0${caps}\n` : `${c}\n`));
  return concat([...parts, FLUSH, ...(pack ? [pack] : [])]);
}
const postReceive = (url: string, body: Uint8Array) =>
  fetch(`${url}/git-receive-pack`, {
    method: "POST",
    headers: { "content-type": "application/x-git-receive-pack-request" },
    body: body as unknown as BodyInit,
  });
/** The report-status lines of a response (side-band demultiplexed). */
async function report(res: Response): Promise<string[]> {
  const outer = new PktReader(res.body as unknown as AsyncIterable<Uint8Array>);
  const inner = new PktReader(readSideband(outer, () => {}));
  const lines: string[] = [];
  for (;;) {
    const p = await inner.read();
    if (!p || p.kind === "flush") break;
    lines.push(text(p) as string);
  }
  return lines;
}
const packOf = (d: string, revs: string) =>
  new Uint8Array(git(d, ["pack-objects", "--stdout", "-q", "--revs"], `${revs}\n`));

describe("R1 native git push to our server", () => {
  for (const backend of ["files", "sql"] as const) {
    it(`new branch, fast-forward, forced, delete, tag, atomic (${backend})`, async () => {
      const src = repoWithHistory(10);
      const declined = new Set<string>();
      const { repo, url } = await ourServer(src, backend, {
        update: async (c: PushCommand) => (declined.has(c.ref) ? "not today" : undefined),
      });
      const work = join(tmp(), "w");
      git(tmpdir(), ["clone", "-q", src, work]);
      const h = rev(work, "HEAD");
      await gitAsync(work, ["push", "-q", url, "HEAD:refs/heads/feature"]);
      expect(await refOf(repo, "refs/heads/feature")).toBe(h);
      commitFile(work, "file0.txt", "ff\n", "ff");
      await gitAsync(work, ["push", "-q", url, "HEAD:refs/heads/feature"]);
      expect(await refOf(repo, "refs/heads/feature")).toBe(rev(work, "HEAD"));
      git(work, ["reset", "-q", "--hard", "HEAD~2"]);
      commitFile(work, "file1.txt", "rewritten\n", "rewrite");
      await expect(
        gitAsync(work, ["push", "-q", url, "HEAD:refs/heads/feature"]),
      ).rejects.toThrow();
      await gitAsync(work, ["push", "-q", "--force", url, "HEAD:refs/heads/feature"]);
      expect(await refOf(repo, "refs/heads/feature")).toBe(rev(work, "HEAD"));
      git(work, ["tag", "-a", "v9", "-m", "v9"]);
      await gitAsync(work, ["push", "-q", url, "refs/tags/v9"]);
      expect(await refOf(repo, "refs/tags/v9")).toBe(rev(work, "refs/tags/v9"));
      await gitAsync(work, ["push", "-q", url, ":refs/heads/feature"]);
      expect(await refOf(repo, "refs/heads/feature")).toBe(ZERO);
      // atomic: one ref declined by the update hook → neither applied
      declined.add("refs/heads/b2");
      await expect(
        gitAsync(work, ["push", "-q", "--atomic", url, "HEAD:refs/heads/b1", "HEAD:refs/heads/b2"]),
      ).rejects.toThrow();
      expect(await refOf(repo, "refs/heads/b1")).toBe(ZERO);
      expect(await refOf(repo, "refs/heads/b2")).toBe(ZERO);
      // non-atomic: the declined one alone fails
      await expect(
        gitAsync(work, ["push", "-q", url, "HEAD:refs/heads/b1", "HEAD:refs/heads/b2"]),
      ).rejects.toThrow();
      expect(await refOf(repo, "refs/heads/b1")).toBe(rev(work, "HEAD"));
      expect(await refOf(repo, "refs/heads/b2")).toBe(ZERO);
      // a native clone of the result is sound
      const check = join(tmp(), "check");
      await gitAsync(tmpdir(), ["clone", "-q", "--bare", "--mirror", url, check]);
      git(check, ["fsck", "--strict"]);
    }, 120_000);
  }
});

describe("R2 our client pushes to git http-backend", () => {
  it("new branch, fast-forward, non-fast-forward refused then forced, delete, atomic", async () => {
    const src = repoWithHistory(10);
    const bare = bareCopy(src);
    const url = await serveNative(bare);
    const work = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", src, work]);
    const repo = await open(work);
    let r = await push(url, repo, { refspecs: ["HEAD:refs/heads/feature"] });
    expect(r).toEqual([{ ref: "refs/heads/feature", ok: true }]);
    expect(rev(bare, "refs/heads/feature")).toBe(rev(work, "HEAD"));
    commitFile(work, "file0.txt", "ff\n", "ff");
    r = await push(url, repo, { refspecs: ["HEAD:refs/heads/feature"] });
    expect(r[0]?.ok).toBe(true);
    git(work, ["reset", "-q", "--hard", "HEAD~2"]);
    commitFile(work, "file1.txt", "rewritten\n", "rewrite");
    r = await push(url, repo, { refspecs: ["HEAD:refs/heads/feature"] });
    expect(r[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/fast-forward/) });
    r = await push(url, repo, { refspecs: ["+HEAD:refs/heads/feature"] });
    expect(r[0]?.ok).toBe(true);
    expect(rev(bare, "refs/heads/feature")).toBe(rev(work, "HEAD"));
    r = await push(url, repo, { refspecs: [":refs/heads/feature"] });
    expect(r[0]?.ok).toBe(true);
    expect(() => rev(bare, "refs/heads/feature")).toThrow();
    r = await push(url, repo, {
      refspecs: ["HEAD:refs/heads/a1", "HEAD:refs/heads/a2"],
      atomic: true,
    });
    expect(r.every((x) => x.ok)).toBe(true);
    git(bare, ["fsck", "--strict"]);
  }, 120_000);
});

describe("R3 concurrency", () => {
  it("a stale old value is refused; atomic: nothing changes", async () => {
    const src = repoWithHistory(5);
    const { repo, url } = await ourServer(src, "files");
    const main = rev(src, "HEAD");
    const parent = rev(src, "HEAD~1");
    // the ref "moved": the client believes main is at HEAD~1
    let lines = await report(
      await postReceive(
        url,
        receiveRequest([`${parent} ${parent} refs/heads/main`], packOf(src, `${parent}^!`)),
      ),
    );
    expect(lines[0]).toBe("unpack ok");
    expect(lines[1]).toMatch(/^ng refs\/heads\/main /);
    expect(await refOf(repo, "refs/heads/main")).toBe(main);
    lines = await report(
      await postReceive(
        url,
        receiveRequest(
          [`${ZERO} ${parent} refs/heads/fresh`, `${parent} ${parent} refs/heads/main`],
          packOf(src, `${parent}^!`),
          "report-status side-band-64k atomic",
        ),
      ),
    );
    expect(lines.filter((l) => l.startsWith("ng ")).length).toBe(2);
    expect(await refOf(repo, "refs/heads/fresh")).toBe(ZERO);
  }, 60_000);
});

describe("R4 connectivity and integrity", () => {
  it("a pack missing the tip's objects, or a corrupt pack: refused, refs unchanged, no temporaries", async () => {
    const src = repoWithHistory(5);
    const { repo, url, dir } = await ourServer(src, "files");
    commitFile(src, "file0.txt", "unseen\n", "unseen");
    const tip = rev(src, "HEAD");
    // the commit alone, without its new tree and blob
    const commitOnly = new Uint8Array(git(src, ["pack-objects", "--stdout", "-q"], `${tip}\n`));
    let lines = await report(
      await postReceive(url, receiveRequest([`${ZERO} ${tip} refs/heads/broken`], commitOnly)),
    );
    expect(lines.join("\n")).toMatch(/ng refs\/heads\/broken missing necessary objects/);
    expect(await refOf(repo, "refs/heads/broken")).toBe(ZERO);
    const good = packOf(src, `${tip}^!`);
    const bad = good.slice();
    bad[Math.floor(bad.length / 2)] = (bad[Math.floor(bad.length / 2)] as number) ^ 0xff;
    lines = await report(
      await postReceive(url, receiveRequest([`${ZERO} ${tip} refs/heads/corrupt`], bad)),
    );
    expect(lines[0]).toMatch(/^unpack /);
    expect(lines[0]).not.toBe("unpack ok");
    expect(await refOf(repo, "refs/heads/corrupt")).toBe(ZERO);
    const leftovers = readdirSync(join(dir as string, "objects", "pack")).filter(
      (n) => !/^pack-[0-9a-f]{40}\.(pack|idx)$/.test(n),
    );
    expect(leftovers).toEqual([]);
  }, 60_000);
});

describe("R5 thin packs", () => {
  it("our client's pack is thin and within 1.10× of native git push's", async () => {
    const src = repoWithHistory(30);
    const sizes: Record<string, number> = {};
    for (const who of ["native", "ours"] as const) {
      const { repo: _r, url } = await ourServer(src, "files");
      const measured = await serve(async (req) => {
        const body = new Uint8Array(await req.arrayBuffer());
        if (req.method === "POST") sizes[who] = body.length;
        return gitHandler(_r)(
          new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.method === "POST" ? (body as unknown as BodyInit) : undefined,
          }),
        );
      });
      void url;
      const work = join(tmp(), `w-${who}`);
      git(tmpdir(), ["clone", "-q", src, work]);
      for (let i = 0; i < 3; i++)
        commitFile(work, `file${i}.txt`, `${"edited line\n".repeat(5)}${i}\n`, `e${i}`);
      if (who === "native") await gitAsync(work, ["push", "-q", measured, "HEAD:refs/heads/main"]);
      else {
        const r = await push(measured, await open(work), { refspecs: ["HEAD:refs/heads/main"] });
        expect(r[0]?.ok).toBe(true);
      }
    }
    console.log(`R5: ours ${sizes.ours} B, native ${sizes.native} B`);
    expect(sizes.ours).toBeLessThanOrEqual((sizes.native as number) * 1.1);
  }, 120_000);
});

describe("R6 streaming", () => {
  it("a pushed 64 MiB blob: the server holds < 16 MiB extra", async () => {
    const src = repoWithHistory(2);
    const { repo, url: _u } = await ourServer(src, "files");
    const gc = () => (globalThis as { gc?: () => void }).gc?.();
    const live = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    let peak = 0;
    let base = 0;
    const handler = gitHandler(repo);
    const url = await serve(async (req) => {
      if (req.method !== "POST" || !req.body) return handler(req);
      gc();
      gc();
      base = live();
      let n = 0;
      const sampled = req.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(c, ctrl) {
            if (++n % 64 === 0) {
              gc();
              peak = Math.max(peak, live() - base);
            }
            ctrl.enqueue(c);
          },
        }),
      );
      return handler(
        new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: sampled, // @ts-expect-error node needs duplex
          duplex: "half",
        }),
      );
    });
    const work = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", src, work]);
    writeFileSync(join(work, "big.bin"), noise(64 * 2 ** 20, 5));
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "big"]);
    await gitAsync(work, [
      "-c",
      "http.postBuffer=1048576",
      "push",
      "-q",
      url,
      "HEAD:refs/heads/big",
    ]);
    console.log(`R6: server peak +${(peak / 2 ** 20).toFixed(1)} MiB`);
    expect(await refOf(repo, "refs/heads/big")).toBe(rev(work, "HEAD"));
    expect(peak).toBeLessThan(16 * 2 ** 20);
  }, 300_000);
});

describe("R7 hostile and invalid requests, hooks", () => {
  it("malformed commands, invalid names, missing packs, oversized: refused; hooks decline", async () => {
    const src = repoWithHistory(4);
    let preReceive: string | undefined;
    const { repo, url } = await ourServer(src, "files", {
      preReceive: async () => preReceive,
      update: async (c: PushCommand) => (c.ref === "refs/heads/nope" ? "hook says no" : undefined),
      maxRequestBytes: 1_000_000,
    });
    const h = rev(src, "HEAD");
    const send = (cmds: string[], pack?: Uint8Array) =>
      postReceive(url, receiveRequest(cmds, pack));
    for (const bad of ["refs/heads/a..b", "HEAD", "refs/heads/x.lock", "refs/heads/sp ace"]) {
      const lines = await report(await send([`${ZERO} ${h} ${bad}`], packOf(src, `${h}^!`)));
      expect(lines.join("\n"), bad).toMatch(/^ng .* (invalid|funny)/m);
    }
    const garbage = await postReceive(url, concat([pkt("not a command\n"), FLUSH]));
    const gtext = new TextDecoder().decode(new Uint8Array(await garbage.arrayBuffer()));
    expect(garbage.status >= 400 || /ERR|ng|unpack/.test(gtext)).toBe(true);
    // a non-delete without its pack
    let lines = await report(await send([`${ZERO} ${h} refs/heads/nopack`]));
    expect(lines.join("\n")).toMatch(/unpack|ng refs\/heads\/nopack/);
    expect(await refOf(repo, "refs/heads/nopack")).toBe(ZERO);
    // oversized: a valid pack (a 2 MB blob) over the 1 MB limit
    const big = join(tmp(), "big");
    git(tmpdir(), ["clone", "-q", src, big]);
    commitFile(big, "big.bin", Buffer.from(noise(2_000_000, 1)).toString("base64"), "big");
    const bigTip = rev(big, "HEAD");
    const huge = await postReceive(
      url,
      receiveRequest([`${ZERO} ${bigTip} refs/heads/huge`], packOf(big, `${bigTip}\n^${h}`)),
    );
    const htext = new TextDecoder().decode(new Uint8Array(await huge.arrayBuffer()));
    expect(huge.status >= 400 || /unpack (?!ok)|ERR/.test(htext)).toBe(true);
    expect(await refOf(repo, "refs/heads/huge")).toBe(ZERO);
    // hooks
    lines = await report(
      await send(
        [`${ZERO} ${h} refs/heads/nope`, `${ZERO} ${h} refs/heads/yes`],
        packOf(src, `${h}^!`),
      ),
    );
    expect(lines).toContain("ng refs/heads/nope hook declined: hook says no");
    expect(lines).toContain("ok refs/heads/yes");
    preReceive = "frozen";
    lines = await report(await send([`${ZERO} ${h} refs/heads/later`], packOf(src, `${h}^!`)));
    expect(lines.join("\n")).toMatch(/ng refs\/heads\/later pre-receive hook declined/);
    expect(await refOf(repo, "refs/heads/later")).toBe(ZERO);
    // our client's atomic push: one ref declined → none applied
    preReceive = undefined;
    const work = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", src, work]);
    const res = await push(url, await open(work), {
      refspecs: ["HEAD:refs/heads/nope", "HEAD:refs/heads/atomic-ok"],
      atomic: true,
    });
    expect(res.every((x) => !x.ok)).toBe(true);
    expect(await refOf(repo, "refs/heads/atomic-ok")).toBe(ZERO);
    // still serving
    lines = await report(await send([`${ZERO} ${h} refs/heads/fine`], packOf(src, `${h}^!`)));
    expect(lines).toContain("ok refs/heads/fine");
    void receivePackHandler;
  }, 60_000);
});

describe("review cases (#82)", () => {
  it("a shallow clone pushes (shallow lines before the commands)", async () => {
    const src = repoWithHistory(8);
    const { repo, url } = await ourServer(src, "files");
    const sh = join(tmp(), "sh");
    git(tmpdir(), ["clone", "-q", "--depth", "1", `file://${src}`, sh]);
    commitFile(sh, "file0.txt", "from a shallow clone\n", "shallow work");
    await gitAsync(sh, ["push", "-q", url, "HEAD:refs/heads/from-shallow"]);
    expect(await refOf(repo, "refs/heads/from-shallow")).toBe(rev(sh, "HEAD"));
  }, 60_000);
  it("a branch must point at a commit; the same ref twice is reported per command; deleting a missing ref is ok", async () => {
    const src = repoWithHistory(3);
    const { repo, url } = await ourServer(src, "files");
    const h = rev(src, "HEAD");
    const tree = rev(src, "HEAD^{tree}");
    const p = rev(src, "HEAD~1");
    let lines = await report(
      await postReceive(
        url,
        receiveRequest([`${ZERO} ${tree} refs/heads/t`], packOf(src, `${h}^!`)),
      ),
    );
    expect(lines[1]).toMatch(/^ng refs\/heads\/t /);
    expect(await refOf(repo, "refs/heads/t")).toBe(ZERO);
    lines = await report(
      await postReceive(
        url,
        receiveRequest(
          [`${ZERO} ${h} refs/heads/d`, `${ZERO} ${p} refs/heads/d`],
          packOf(src, `${h}^!`),
        ),
      ),
    );
    expect(lines.slice(1)).toEqual([
      "ok refs/heads/d",
      expect.stringMatching(/^ng refs\/heads\/d /),
    ]);
    expect(await refOf(repo, "refs/heads/d")).toBe(h);
    lines = await report(
      await postReceive(url, receiveRequest([`${ZERO} ${ZERO} refs/heads/nonexist`])),
    );
    expect(lines).toContain("ok refs/heads/nonexist");
  }, 60_000);
  it("the connectivity check is one walk: 200 refs, 200 commands → reads linear, not quadratic", async () => {
    const src = repoWithHistory(3);
    for (let i = 0; i < 200; i++) git(src, ["update-ref", `refs/heads/old${i}`, "HEAD"]);
    const { repo, url } = await ourServer(src, "files");
    const get = repo.objects.get.bind(repo.objects);
    let reads = 0;
    repo.objects.get = async (oid, o) => {
      reads++;
      return get(oid, o);
    };
    const h = rev(src, "HEAD");
    const cmds = Array.from({ length: 200 }, (_, i) => `${ZERO} ${h} refs/heads/new${i}`);
    const lines = await report(await postReceive(url, receiveRequest(cmds, packOf(src, `${h}^!`))));
    expect(lines.filter((l) => l.startsWith("ok ")).length).toBe(200);
    console.log(`#82 connectivity: ${reads} reads for 200 refs × 200 commands`);
    expect(reads).toBeLessThan(3000);
  }, 120_000);
  it("a stalled push does not block another push", async () => {
    const src = repoWithHistory(3);
    const { repo, url } = await ourServer(src, "files", { idleTimeoutMs: 1500 });
    const h = rev(src, "HEAD");
    const pack = packOf(src, `${h}^!`);
    const stalled = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(receiveRequest([`${ZERO} ${h} refs/heads/stalled`], pack.subarray(0, 40)));
      },
    });
    const ac = new AbortController();
    const a = fetch(`${url}/git-receive-pack`, {
      method: "POST",
      body: stalled,
      signal: ac.signal,
      // @ts-expect-error node needs duplex for a streamed body
      duplex: "half",
    }).then(
      (res) => report(res),
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const lines = await report(
      await postReceive(url, receiveRequest([`${ZERO} ${h} refs/heads/b`], pack)),
    );
    const took = Date.now() - t0;
    // the stalled upload is abandoned after its idle timeout: an unpack error, no ref
    const aLines = await a;
    ac.abort();
    expect(aLines?.[0]).toMatch(/^unpack .*idle/);
    expect(lines).toContain("ok refs/heads/b");
    expect(took).toBeLessThan(5000);
    expect(await refOf(repo, "refs/heads/stalled")).toBe(ZERO);
  }, 60_000);
  it("hook messages stay on one report line; too many commands are refused", async () => {
    const src = repoWithHistory(3);
    const { url } = await ourServer(src, "files", {
      preReceive: async () => "line1\nline2",
      maxCommands: 100,
    });
    const h = rev(src, "HEAD");
    const lines = await report(
      await postReceive(url, receiveRequest([`${ZERO} ${h} refs/heads/nl`], packOf(src, `${h}^!`))),
    );
    expect(lines).toContain("ng refs/heads/nl pre-receive hook declined: line1 line2");
    const many = Array.from({ length: 101 }, (_, i) => `${ZERO} ${h} refs/heads/m${i}`);
    const res = await postReceive(url, receiveRequest(many, packOf(src, `${h}^!`)));
    expect(res.status).toBeGreaterThanOrEqual(400);
  }, 60_000);
  it("client: git's refspec rules (no colon, short names, tags first), fast-forward outside branches, needs force", async () => {
    const src = repoWithHistory(4);
    git(src, ["tag", "rel", "HEAD~1"]);
    const bare = bareCopy(src);
    const url = await serveNative(bare);
    const work = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", src, work]);
    git(work, ["checkout", "-q", "-b", "topic"]);
    commitFile(work, "file0.txt", "topic\n", "topic");
    git(work, ["tag", "v1"]);
    const repo = await open(work);
    let r = await push(url, repo, { refspecs: ["HEAD"] });
    expect(r).toEqual([{ ref: "refs/heads/topic", ok: true }]);
    r = await push(url, repo, { refspecs: ["v1"] });
    expect(r).toEqual([{ ref: "refs/tags/v1", ok: true }]);
    r = await push(url, repo, { refspecs: [":rel"] });
    expect(r).toEqual([{ ref: "refs/tags/rel", ok: true }]);
    expect(() => rev(bare, "refs/tags/rel")).toThrow();
    r = await push(url, repo, { refspecs: ["topic:feature"] }); // a new short destination: a branch
    expect(r[0]?.ref).toBe("refs/heads/feature");
    // refs/notes: the fast-forward rule applies outside refs/heads too
    git(bare, ["update-ref", "refs/notes/x", rev(work, "HEAD")]);
    r = await push(url, repo, { refspecs: ["HEAD~1:refs/notes/x"] });
    expect(r[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/non-fast-forward/) });
    // needs force: replacing a commit with a tree
    r = await push(url, repo, { refspecs: [`${rev(work, "HEAD^{tree}")}:refs/notes/x`] });
    expect(r[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/needs force/) });
  }, 60_000);
  it("client: only advertised capabilities are asked (no side-band, no ofs-delta)", async () => {
    const src = repoWithHistory(3);
    const { repo: server } = await ourServer(src, "files");
    const inner = gitHandler(server);
    let firstLine = "";
    const url = await serve(async (req) => {
      if (req.method === "GET") {
        const res = await inner(req);
        const text0 = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
        const stripped = text0.replace(" side-band-64k", "").replace(" ofs-delta", "");
        // the length prefix of the line with capabilities changes: rebuild it
        const out = stripped.replace(
          /([0-9a-f]{4})([0-9a-f]{40} [^\n]*\0[^\n]*\n)/,
          (_m, _l, line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`,
        );
        return new Response(out, { headers: res.headers });
      }
      const body = new Uint8Array(await req.arrayBuffer());
      const first = new TextDecoder().decode(
        body.subarray(4, Number.parseInt(new TextDecoder().decode(body.subarray(0, 4)), 16)),
      );
      firstLine = first;
      return inner(
        new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: body as unknown as BodyInit,
        }),
      );
    });
    const work = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", src, work]);
    commitFile(work, "file0.txt", "x\n", "x");
    const r = await push(url, await open(work), { refspecs: ["HEAD:refs/heads/caps"] });
    expect(r[0]?.ok).toBe(true);
    expect(firstLine).not.toMatch(/side-band-64k|ofs-delta/);
  }, 60_000);
});

describe("R8 post-receive", () => {
  for (const backend of ["files", "sql"] as const)
    it(`${backend}: the refs that moved, after the report, read or not; a throwing hook is ignored`, async () => {
      const src = repoWithHistory(4);
      const h = rev(src, "HEAD");
      const p = rev(src, "HEAD~1");
      const calls: PushCommand[][] = [];
      let throwing = false;
      const { repo, url } = await ourServer(src, backend, {
        update: async (c: PushCommand) => (c.ref === "refs/heads/nope" ? "no" : undefined),
        postReceive: async (updated: PushCommand[]) => {
          // the refs have moved by now
          for (const c of updated) expect(await refOf(repo, c.ref)).toBe(c.new);
          calls.push(updated);
          if (throwing) throw new Error("hook failed");
        },
      });
      const pack = packOf(src, `${h}^!`);
      // read: one moved, one declined by update, one stale old value
      let lines = await report(
        await postReceive(
          url,
          receiveRequest(
            [
              `${ZERO} ${h} refs/heads/yes`,
              `${ZERO} ${h} refs/heads/nope`,
              `${p} ${h} refs/heads/stale`,
            ],
            pack,
          ),
        ),
      );
      expect(lines).toEqual(
        expect.arrayContaining([
          "ok refs/heads/yes",
          expect.stringMatching(/^ng refs\/heads\/nope/),
          expect.stringMatching(/^ng refs\/heads\/stale/),
        ]),
      );
      await expect.poll(() => calls.length).toBe(1);
      expect(calls[0]).toEqual([{ ref: "refs/heads/yes", old: ZERO, new: h }]);
      // nothing moved: no call
      lines = await report(
        await postReceive(url, receiveRequest([`${ZERO} ${h} refs/heads/nope`], pack)),
      );
      expect(lines.join("\n")).toMatch(/^ng refs\/heads\/nope/m);
      // atomic: all of them, in command order
      lines = await report(
        await postReceive(
          url,
          receiveRequest(
            [`${h} ${p} refs/heads/yes`, `${ZERO} ${p} refs/heads/two`],
            pack,
            "report-status side-band-64k atomic",
          ),
        ),
      );
      expect(lines).toEqual(["unpack ok", "ok refs/heads/yes", "ok refs/heads/two"]);
      await expect.poll(() => calls.length).toBe(2);
      expect(calls[1]?.map((c) => c.ref)).toEqual(["refs/heads/yes", "refs/heads/two"]);
      // the response never read (and the hook throws): still called, and the server goes on
      throwing = true;
      lines = await report(
        await postReceive(url, receiveRequest([`${ZERO} ${h} refs/heads/thrown`], pack)),
      );
      expect(lines).toContain("ok refs/heads/thrown");
      await expect.poll(() => calls.length).toBe(3);
      const unread = await postReceive(
        url,
        receiveRequest([`${ZERO} ${h} refs/heads/unread`], pack),
      );
      await expect.poll(() => calls.length).toBe(4);
      await unread.body?.cancel();
      throwing = false;
      lines = await report(
        await postReceive(url, receiveRequest([`${h} ${p} refs/heads/unread`], pack)),
      );
      expect(lines).toContain("ok refs/heads/unread");
      await expect.poll(() => calls.length).toBe(5);
      // and a handler called directly, its body never touched
      const direct = receivePackHandler(repo, { postReceive: (u) => void calls.push(u) });
      await direct(
        new Request(`${url}/git-receive-pack`, {
          method: "POST",
          headers: { "content-type": "application/x-git-receive-pack-request" },
          body: receiveRequest([`${ZERO} ${h} refs/heads/direct`], pack) as unknown as BodyInit,
        }),
      );
      await expect.poll(() => calls.length).toBe(6);
      expect(calls[5]).toEqual([{ ref: "refs/heads/direct", old: ZERO, new: h }]);
    }, 60_000);
});

describe("R8b (review of #118) post-receive does not hold the report", () => {
  it("a hook that never settles: the report is read in full, the hook started after the refs moved", async () => {
    const src = repoWithHistory(3);
    const h = rev(src, "HEAD");
    let started = 0;
    const { url } = await ourServer(src, "files", {
      postReceive: () => {
        started++;
        return new Promise<void>(() => {});
      },
    });
    const lines = await report(
      await postReceive(
        url,
        receiveRequest([`${ZERO} ${h} refs/heads/held`], packOf(src, `${h}^!`)),
      ),
    );
    expect(lines).toEqual(["unpack ok", "ok refs/heads/held"]);
    await expect.poll(() => started).toBe(1);
  });
});
