import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, noise, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { log } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository, sqlRepository } from "../../17-repository/src/repository.js";
import { clone, type FetchStats, fetchFrom, filesShallow } from "../src/client.js";
import {
  DELIM,
  FLUSH,
  PktError,
  PktReader,
  pkt,
  RESPONSE_END,
  readSideband,
  sideband,
} from "../src/pkt-line.js";
import { uploadPackHandler } from "../src/server.js";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x8a-"));
  dirs.push(d);
  return d;
};
const enc = new TextEncoder();
const dec = new TextDecoder();
const open = (dir: string) =>
  filesRepository(new StreamingNodeFilesApi(join(dir, ".git")), nodeRefFiles(join(dir, ".git")));
const emptyRepo = () => {
  const d = tmp();
  git(d, ["init", "-q", "-b", "main", "."]);
  return d;
};
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

/** Serves a fetch handler on 127.0.0.1 (the URL ends in /repo.git). */
async function serve(handler: (req: Request) => Promise<Response>): Promise<string> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>);
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

/** `git http-backend` as CGI behind node:http: the repository `dir` served at /repo.git. */
async function serveNative(dir: string): Promise<string> {
  const root = join(dir, "..");
  const name = dir.slice(root.length + 1);
  return serve(async (req) => {
    const u = new URL(req.url);
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: u.pathname.replace(/^\/repo\.git/, `/${name}/.git`),
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

const objectsIn = (dir: string) =>
  git(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .toString()
    .trim()
    .split("\n")
    .sort();
const refsOf = (dir: string) =>
  git(dir, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"])
    .toString()
    .trim();

describe("R1 pkt-line and side-band codecs", () => {
  it("round trip, split at every offset, special packets", async () => {
    const stream = concat([
      pkt("command=fetch\n"),
      DELIM,
      pkt(new Uint8Array([0, 1, 2, 255])),
      FLUSH,
      pkt("x"),
      RESPONSE_END,
    ]);
    const decode = async (src: AsyncIterable<Uint8Array>) => {
      const r = new PktReader(src);
      const out: string[] = [];
      for (;;) {
        const p = await r.read();
        if (!p) break;
        out.push(p.kind === "data" ? `data:${Buffer.from(p.data).toString("hex")}` : p.kind);
      }
      return out;
    };
    const whole = await decode(chunksOf(stream, stream.length));
    expect(whole).toEqual([
      `data:${Buffer.from("command=fetch\n").toString("hex")}`,
      "delim",
      "data:000102ff",
      "flush",
      `data:${Buffer.from("x").toString("hex")}`,
      "end",
    ]);
    for (let size = 1; size <= stream.length; size++)
      expect(await decode(chunksOf(stream, size)), `chunks of ${size}`).toEqual(whole);
  });
  it("refuses bad lengths and non-hex", async () => {
    for (const bad of ["0003", "0004", "fff1", "00zz", "000a12"]) {
      const r = new PktReader(chunksOf(enc.encode(bad), 2));
      await expect(r.read(), bad).rejects.toBeInstanceOf(PktError);
    }
  });
  it("side-band: data split to ≤ 65515-byte packets, progress and errors demultiplexed", async () => {
    const data = noise(200000, 3);
    const stream = concat([...sideband(1, data), ...sideband(2, enc.encode("counting\n")), FLUSH]);
    const progress: string[] = [];
    const got = concat(
      await Array.fromAsync(
        readSideband(new PktReader(chunksOf(stream, 777)), (m) => progress.push(m)),
      ),
    );
    expect(Buffer.compare(got, data)).toBe(0);
    expect(progress.join("")).toBe("counting\n");
    for (const p of sideband(1, data)) expect(p.length).toBeLessThanOrEqual(65520);
    const err = concat([...sideband(3, enc.encode("boom")), FLUSH]);
    await expect(
      Array.fromAsync(readSideband(new PktReader(chunksOf(err, 3)), () => {})),
    ).rejects.toThrow(/boom/);
  });
});

describe("R2 native git against our server", () => {
  for (const backend of ["files", "sql"] as const) {
    it(`clone (${backend}), shallow clone, incremental fetch`, async () => {
      const src = repoWithHistory(20);
      git(src, ["tag", "-a", "v1", "-m", "release", "HEAD~3"]);
      let repo: Repository;
      if (backend === "files") repo = await open(src);
      else {
        repo = await sqlRepository(await newNodeSqliteDb());
        const pack = git(src, ["pack-objects", "--stdout", "-q", "--all"], "");
        await repo.objects.installPack(chunksOf(new Uint8Array(pack), 65536));
        const refs = refsOf(src)
          .split("\n")
          .map((l) => l.split(" "))
          .map(([oid, name]) => ({ name: name as string, new: oid as string }));
        await repo.refs.batch(refs);
        await repo.refs.setSymref("HEAD", "refs/heads/main");
      }
      const url = await serve(uploadPackHandler(repo));
      const dst = join(tmp(), "c");
      await gitAsync(tmpdir(), ["-c", "protocol.version=2", "clone", "-q", "--bare", url, dst]);
      expect(refsOf(dst)).toBe(refsOf(src));
      expect(git(dst, ["symbolic-ref", "HEAD"]).toString().trim()).toBe("refs/heads/main");
      expect(objectsIn(dst)).toEqual(objectsIn(src).filter((o) => objectsIn(dst).includes(o)));
      git(dst, ["fsck", "--strict"]);
      // shallow
      const sh = join(tmp(), "s");
      await gitAsync(tmpdir(), ["clone", "-q", "--bare", "--depth", "1", url, sh]);
      expect(readFileSync(join(sh, "shallow"), "utf8").trim()).toBe(rev(src, "HEAD"));
      expect(git(sh, ["rev-list", "--count", "HEAD"]).toString().trim()).toBe("1");
      git(sh, ["fsck"]);
      if (backend === "files") {
        // incremental: 2 new commits; the pack carries only new objects
        writeFileSync(join(src, "file0.txt"), "new content\n");
        git(src, ["commit", "-q", "-am", "new 1"]);
        writeFileSync(join(src, "file1.txt"), "more new content\n");
        git(src, ["commit", "-q", "-am", "new 2"]);
        const before = new Set(objectsIn(dst));
        await gitAsync(dst, ["fetch", "-q", url, "+refs/heads/*:refs/heads/*"]);
        const after = objectsIn(dst);
        const added = after.filter((o) => !before.has(o));
        const expected = git(src, ["rev-list", "--objects", "HEAD~2..HEAD"])
          .toString()
          .trim()
          .split("\n").length;
        expect(added.length).toBe(expected);
        expect(rev(dst, "refs/heads/main")).toBe(rev(src, "HEAD"));
        git(dst, ["fsck", "--strict"]);
      }
    }, 120_000);
  }
});

describe("R3 our client against git http-backend", () => {
  it("clone, shallow clone, incremental fetch", async () => {
    const src = repoWithHistory(20);
    git(src, ["tag", "v1", "HEAD~2"]);
    const url = await serveNative(src);
    const d = emptyRepo();
    const repo = await open(d);
    await clone(url, repo);
    expect(refsOf(d)).toBe(refsOf(src));
    expect(git(d, ["symbolic-ref", "HEAD"]).toString().trim()).toBe("refs/heads/main");
    git(d, ["fsck", "--strict"]);
    // shallow
    const s = emptyRepo();
    const srepo = await open(s);
    await clone(url, srepo, {
      depth: 1,
      shallow: filesShallow(new StreamingNodeFilesApi(join(s, ".git")), "/shallow"),
    });
    expect(readFileSync(join(s, ".git", "shallow"), "utf8").trim()).toBe(rev(src, "HEAD"));
    expect(git(s, ["rev-list", "--count", "HEAD"]).toString().trim()).toBe("1");
    git(s, ["fsck"]);
    // incremental
    writeFileSync(join(src, "file2.txt"), "fresh\n");
    git(src, ["commit", "-q", "-am", "fresh"]);
    git(src, ["tag", "-a", "v2", "-m", "fresh release"]);
    const stats: FetchStats = { haves: 0, rounds: 0, objects: 0 };
    await fetchFrom(url, repo, { refspecs: ["+refs/heads/*:refs/heads/*"], stats });
    expect(rev(d, "refs/heads/main")).toBe(rev(src, "HEAD"));
    // the annotated tag on the fetched commit came along (include-tag) and was followed
    expect(rev(d, "refs/tags/v2")).toBe(rev(src, "refs/tags/v2"));
    expect(stats.objects).toBe(
      git(src, ["rev-list", "--objects", "HEAD~1..HEAD"]).toString().trim().split("\n").length + 1,
    );
    git(d, ["fsck", "--strict"]);
  }, 120_000);
});

describe("R4 our client against our server", () => {
  it("an SQL repository serves a files-backend clone: logs equal", async () => {
    const src = repoWithHistory(15);
    const server = await sqlRepository(await newNodeSqliteDb());
    const pack = git(src, ["pack-objects", "--stdout", "-q", "--all"], "");
    await server.objects.installPack(chunksOf(new Uint8Array(pack), 65536));
    await server.refs.batch([{ name: "refs/heads/main", new: rev(src, "HEAD") }]);
    await server.refs.setSymref("HEAD", "refs/heads/main");
    const url = await serve(uploadPackHandler(server));
    const d = emptyRepo();
    const repo = await open(d);
    await clone(url, repo);
    expect(await log(repo, "HEAD")).toEqual(await log(server, "HEAD"));
    git(d, ["fsck", "--strict"]);
  }, 120_000);
});

/** Counts object reads of a repository (a wrapper over its object store). */
function counted(repo: Repository) {
  const c = { reads: 0 };
  const get = repo.objects.get.bind(repo.objects);
  repo.objects.get = async (oid, o) => {
    c.reads++;
    return get(oid, o);
  };
  return c;
}
/** A protocol v2 fetch request for all of `wants`. */
const fetchRequest = (wants: string[], extra: string[] = [], noProgress = true) =>
  concat([
    pkt("command=fetch\n"),
    pkt("agent=test\n"),
    pkt("object-format=sha1\n"),
    DELIM,
    pkt("ofs-delta\n"),
    ...(noProgress ? [pkt("no-progress\n")] : []),
    ...wants.map((w) => pkt(`want ${w}\n`)),
    ...extra.map((l) => pkt(`${l}\n`)),
    pkt("done\n"),
    FLUSH,
  ]);
const post = (url: string, body: Uint8Array, signal?: AbortSignal) =>
  fetch(`${url}/git-upload-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      "git-protocol": "version=2",
    },
    body: body as unknown as BodyInit,
    signal,
  });

describe("R5 streaming", () => {
  /** Reads a fetch response; the object reads counted when the first progress and pack bytes arrive. */
  async function firstBytes(res: Response, c: { reads: number }) {
    const reader = new PktReader(res.body as unknown as AsyncIterable<Uint8Array>);
    let progress = -1;
    let pack = -1;
    let inPack = false;
    for (;;) {
      const p = await reader.read();
      if (!p) break;
      if (p.kind !== "data") continue;
      if (!inPack) {
        if (dec.decode(p.data) === "packfile\n") inPack = true;
        continue;
      }
      if (p.data[0] === 2 && progress < 0) progress = c.reads;
      if (p.data[0] === 1 && pack < 0) pack = c.reads;
    }
    return { progress, pack, total: c.reads };
  }
  /** Aborts once the generation is under way: a "Compressing objects" message (search) or pack data. */
  async function abortAfterFirstBytes(url: string, head: string, c: { reads: number }) {
    const before = c.reads;
    const ac = new AbortController();
    const res = await post(url, fetchRequest([head], [], false), ac.signal);
    const reader = new PktReader(res.body as unknown as AsyncIterable<Uint8Array>);
    let inPack = false;
    for (;;) {
      const p = await reader.read();
      if (!p) break;
      if (p.kind !== "data") continue;
      if (!inPack) {
        inPack = dec.decode(p.data) === "packfile\n";
        continue;
      }
      if (p.data[0] === 1) break;
      if (p.data[0] === 2 && /^Compressing objects: [1-9]/.test(dec.decode(p.data.subarray(1))))
        break;
    }
    const atBreak = c.reads - before;
    ac.abort();
    await reader.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const atAbort = c.reads - before;
    await new Promise((r) => setTimeout(r, 1000));
    return { atBreak, atAbort, later: c.reads - before };
  }
  it("bytes flow before half of the objects are read (progress while searching; pack data at once with reuse); abort stops the reads", async () => {
    const d = emptyRepo();
    for (let i = 0; i < 64; i++) writeFileSync(join(d, `b${i}.bin`), noise(512 * 1024, i + 1));
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "blobs"]);
    const head = rev(d, "HEAD");
    const repo = await open(d);
    const c = counted(repo);
    const searching = await serve(uploadPackHandler(repo));
    const reusing = await serve(uploadPackHandler(repo, { search: false }));
    c.reads = 0;
    const s = await firstBytes(await post(searching, fetchRequest([head], [], false)), c);
    c.reads = 0;
    const r = await firstBytes(await post(reusing, fetchRequest([head], [], false)), c);
    console.log(
      `R5 search: first progress after ${s.progress}, first pack byte after ${s.pack} of ${s.total} reads`,
    );
    console.log(`R5 reuse: first pack byte after ${r.pack} of ${r.total} reads`);
    expect(s.progress).toBeGreaterThanOrEqual(0);
    expect(s.progress).toBeLessThan(s.total / 2);
    expect(r.pack).toBeGreaterThanOrEqual(0);
    expect(r.pack).toBeLessThan(r.total / 2);
    for (const [name, url, total] of [
      ["search", searching, s.total],
      ["reuse", reusing, r.total],
    ] as const) {
      const a = await abortAfterFirstBytes(url, head, c);
      console.log(
        `R5 abort (${name}): ${a.atBreak} when aborting, ${a.atAbort} after 1.5 s, ${a.later} a second later, of ${total}`,
      );
      expect(a.later).toBe(a.atAbort);
      // the generation stopped mid-way (the search included), not after reading everything
      expect(a.later).toBeLessThan(total / 2);
    }
  }, 120_000);
});

describe("R6 negotiation", () => {
  it("3 new commits on a 300-commit history: ≤ 64 haves, only the new objects", async () => {
    const src = emptyRepo();
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(src, `f${i % 10}.txt`), `commit ${i}\n`);
      git(src, ["add", "-A"]);
      git(src, ["commit", "-q", "-m", `c${i}`, "--date", `${1700000000 + i * 60} +0000`]);
    }
    const server = await open(src);
    const url = await serve(uploadPackHandler(server));
    const d = emptyRepo();
    const repo = await open(d);
    await clone(url, repo);
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(src, "new.txt"), `new ${i}\n`);
      git(src, ["add", "-A"]);
      git(src, ["commit", "-q", "-m", `n${i}`, "--date", `${1800000000 + i * 60} +0000`]);
    }
    const stats: FetchStats = { haves: 0, rounds: 0, objects: 0 };
    await fetchFrom(url, repo, { refspecs: ["+refs/heads/*:refs/heads/*"], stats });
    console.log(`R6: ${JSON.stringify(stats)}`);
    expect(stats.haves).toBeLessThanOrEqual(64);
    expect(stats.objects).toBe(
      git(src, ["rev-list", "--objects", "HEAD~3..HEAD"]).toString().trim().split("\n").length,
    );
    expect(rev(d, "refs/heads/main")).toBe(rev(src, "HEAD"));
  }, 180_000);
  it("git's give-up: an early ACK, then 256 haves in vain → done; no ACK at all → every have", async () => {
    const src = repoWithHistory(5);
    const url = await serve(uploadPackHandler(await open(src)));
    const d = emptyRepo();
    const repo = await open(d);
    await clone(url, repo);
    // 600 unrelated commits on another branch, older than the cloned tip (git fast-import)
    let stream = "";
    for (let i = 0; i < 600; i++) {
      const data = `unrelated ${i}\n`;
      stream += `commit refs/heads/other\ncommitter u <u@x> ${1000000000 + i} +0000\ndata 2\nu\n`;
      stream += `M 100644 inline x.txt\ndata ${data.length}\n${data}\n`;
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: d, input: stream });
    writeFileSync(join(src, "file3.txt"), "upstream\n");
    git(src, ["commit", "-q", "-am", "upstream"]);
    const stats: FetchStats = { haves: 0, rounds: 0, objects: 0 };
    await fetchFrom(url, repo, { refspecs: ["+refs/heads/main:refs/heads/main"], stats });
    console.log(`R6 in vain: ${JSON.stringify(stats)}`);
    // the server is ready once the cloned tip is ACKed, after the first round
    expect(stats.haves).toBeLessThanOrEqual(16);
    expect(rev(d, "refs/heads/main")).toBe(rev(src, "HEAD"));
    // a server that never says ready: after the ACK, 256 haves in vain end it with done
    const stubborn = await serve(uploadPackHandler(await open(src), { neverReady: true }));
    writeFileSync(join(src, "file3.txt"), "upstream 2\n");
    git(src, ["commit", "-q", "-am", "upstream 2"]);
    const s2: FetchStats = { haves: 0, rounds: 0, objects: 0 };
    await fetchFrom(stubborn, repo, { refspecs: ["+refs/heads/main:refs/heads/main"], stats: s2 });
    console.log(`R6 stubborn: ${JSON.stringify(s2)}`);
    // rounds of 16, 32, 64, 128: 224 in vain after the ACK; the next request adds 256 more and,
    // past 256 in vain, says done (git decides "done" as it builds a request): 496 of 606
    expect(s2.haves).toBe(16 + 32 + 64 + 128 + 256);
    // the commons were re-sent with "done" (stateless): only the new commit's objects came
    expect(s2.objects).toBe(3);
    expect(rev(d, "refs/heads/main")).toBe(rev(src, "HEAD"));
    // an unrelated repository: no ACK ever, so every have is sent (git gives up only after an ACK)
    const u = emptyRepo();
    let alone = "";
    for (let i = 0; i < 600; i++) {
      const data = `alone ${i}\n`;
      alone += `commit refs/heads/main\ncommitter a <a@x> ${1100000000 + i} +0000\ndata 2\na\n`;
      alone += `M 100644 inline y.txt\ndata ${data.length}\n${data}\n`;
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: u, input: alone });
    const s3: FetchStats = { haves: 0, rounds: 0, objects: 0 };
    await fetchFrom(url, await open(u), {
      refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
      stats: s3,
    });
    expect(s3.haves).toBe(600); // past 496: no give-up without an ACK
    expect(rev(u, "refs/remotes/origin/main")).toBe(rev(src, "HEAD"));
  }, 180_000);
});

describe("R7 hostile requests", () => {
  it("unadvertised wants, malformed and oversized lines, unknown commands: errors, no pack", async () => {
    const src = repoWithHistory(3);
    const repo = await open(src);
    const url = await serve(uploadPackHandler(repo));
    // a commit in the repository that no ref reaches (git v2 serves reachable non-tips)
    const dangling = git(src, ["commit-tree", "-m", "dangling", `${rev(src, "HEAD")}^{tree}`])
      .toString()
      .trim();
    const bodies: [string, Uint8Array][] = [
      ["not our ref", fetchRequest([dangling])],
      ["unknown object", fetchRequest(["1".repeat(40)])],
      ["malformed length", enc.encode("00zzcommand=fetch\n")],
      ["oversized", enc.encode(`fff0${"a".repeat(100)}`)],
      ["unknown command", concat([pkt("command=frobnicate\n"), DELIM, FLUSH])],
      ["unknown argument", fetchRequest([rev(src, "HEAD")], ["frobnicate yes"])],
      ["truncated", concat([pkt("command=fetch\n"), enc.encode("0010want")])],
    ];
    for (const [name, body] of bodies) {
      const res = await post(url, body);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = dec.decode(bytes);
      expect(res.status >= 400 || /ERR /.test(text), name).toBe(true);
      expect(text.includes("packfile"), name).toBe(false);
    }
    // the server still serves afterwards
    const ok = await post(url, fetchRequest([rev(src, "HEAD")]));
    expect(dec.decode(new Uint8Array(await ok.arrayBuffer()))).toContain("packfile");
    // a request without protocol v2 is refused clearly
    const v0 = await fetch(`${url}/info/refs?service=git-upload-pack`);
    expect(v0.status).toBeGreaterThanOrEqual(400);
  });
});

describe("review cases (#81)", () => {
  const commitAll = (d: string, msg: string) => {
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", msg]);
  };
  it("gzip request bodies (git compresses POSTs over 1 KiB): native clone of 30 branches, fetch with 600 haves", async () => {
    const src = repoWithHistory(5);
    for (let i = 0; i < 30; i++) git(src, ["branch", `b${i}`, `HEAD~${i % 4}`]);
    const url = await serve(uploadPackHandler(await open(src)));
    const dst = join(tmp(), "c");
    await gitAsync(tmpdir(), ["clone", "-q", "--bare", url, dst]);
    expect(refsOf(dst)).toBe(refsOf(src));
    // and a gzip body sent directly
    const res = await fetch(`${url}/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
        "git-protocol": "version=2",
      },
      body: gzipSync(fetchRequest([rev(src, "HEAD")])) as unknown as BodyInit,
    });
    expect(dec.decode(new Uint8Array(await res.arrayBuffer()))).toContain("packfile");
  }, 120_000);
  it("tag chains: include-tag sends every tag of the chain; auto-follow needs the whole chain", async () => {
    const src = repoWithHistory(3);
    git(src, ["tag", "-a", "inner", "-m", "inner"]);
    git(src, ["tag", "-a", "outer", "-m", "outer", "inner"]);
    git(src, ["tag", "-d", "inner"]); // only the outer tag is a ref: the inner one exists only as an object
    const url = await serve(uploadPackHandler(await open(src)));
    const d = emptyRepo();
    const repo = await open(d);
    await fetchFrom(url, repo, { refspecs: ["+refs/heads/main:refs/heads/main"] });
    expect(rev(d, "refs/tags/outer")).toBe(rev(src, "refs/tags/outer"));
    git(d, ["fsck", "--strict"]);
  }, 60_000);
  it("deepening a shallow clone: native --depth 5 and --unshallow, and our client's depth", async () => {
    const src = repoWithHistory(14);
    const url = await serve(uploadPackHandler(await open(src)));
    const sh = join(tmp(), "s");
    await gitAsync(tmpdir(), ["clone", "-q", "--bare", "--depth", "1", url, sh]);
    await gitAsync(sh, ["fetch", "-q", "--depth", "5", url, "+refs/heads/*:refs/heads/*"]);
    expect(git(sh, ["rev-list", "--count", "HEAD"]).toString().trim()).toBe("5");
    git(sh, ["fsck"]);
    await gitAsync(sh, ["fetch", "-q", "--unshallow", url, "+refs/heads/*:refs/heads/*"]);
    expect(git(sh, ["rev-list", "--count", "HEAD"]).toString().trim()).toBe("14");
    expect(git(sh, ["rev-parse", "--is-shallow-repository"]).toString().trim()).toBe("false");
    git(sh, ["fsck", "--strict"]);
    // our client: depth 1, then depth 5 with the tips already here
    const d = emptyRepo();
    const repo = await open(d);
    const shallow = filesShallow(new StreamingNodeFilesApi(join(d, ".git")), "/shallow");
    await clone(url, repo, { depth: 1, shallow });
    await fetchFrom(url, repo, {
      refspecs: ["+refs/heads/main:refs/heads/main"],
      depth: 5,
      shallow,
    });
    expect(git(d, ["rev-list", "--count", "HEAD"]).toString().trim()).toBe("5");
    git(d, ["fsck"]);
    // depth without a shallow store would leave a broken repository: refused
    await expect(clone(url, await open(emptyRepo()), { depth: 1 })).rejects.toThrow(/shallow/);
  }, 120_000);
  it("a producer error while the client cancels does not crash the process", async () => {
    // the search queues progress past the channel's high-water mark, then a read fails; the
    // error's write waits, and the client's cancel then rejects it
    const d = emptyRepo();
    for (let i = 0; i < 64; i++) writeFileSync(join(d, `b${i}.bin`), noise(4096, i + 1));
    commitAll(d, "blobs");
    const repo = await open(d);
    const get = repo.objects.get.bind(repo.objects);
    let n = 0;
    repo.objects.get = async (oid, o) => {
      if (++n >= 120) throw new Error("disk read error");
      return get(oid, o);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await uploadPackHandler(repo)(
        new Request("http://x/repo.git/git-upload-pack", {
          method: "POST",
          headers: { "git-protocol": "version=2" },
          body: fetchRequest([rev(d, "HEAD")], [], false) as unknown as BodyInit,
        }),
      );
      await new Promise((r) => setTimeout(r, 1000));
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled.map(String)).toEqual([]);
  });
  it("annotated tags do not leak file descriptors", async () => {
    const src = repoWithHistory(3);
    for (let i = 0; i < 50; i++) git(src, ["tag", "-a", `t${i}`, "-m", `t${i}`]);
    const url = await serve(uploadPackHandler(await open(src)));
    const lsRefs = concat([pkt("command=ls-refs\n"), DELIM, pkt("peel\n"), FLUSH]);
    const fds = () => readdirSync("/proc/self/fd").length;
    await (await post(url, lsRefs)).arrayBuffer();
    const before = fds();
    for (let i = 0; i < 5; i++) await (await post(url, lsRefs)).arrayBuffer();
    expect(fds() - before).toBeLessThan(10);
  });
  it("duplicate wants and haves cost no more than one", async () => {
    const src = repoWithHistory(30);
    const repo = await open(src);
    const c = counted(repo);
    const url = await serve(uploadPackHandler(repo));
    const head = rev(src, "HEAD");
    const root = git(src, ["rev-list", "--max-parents=0", "HEAD"]).toString().trim();
    const ask = async (k: number) => {
      c.reads = 0;
      const body = concat([
        pkt("command=fetch\n"),
        DELIM,
        ...Array.from({ length: k }, () => pkt(`want ${head}\n`)),
        ...Array.from({ length: k }, () => pkt(`have ${root}\n`)),
        FLUSH,
      ]);
      await (await post(url, body)).arrayBuffer();
      return c.reads;
    };
    const one = await ask(1);
    expect(await ask(2000)).toBeLessThanOrEqual(one + 2);
  });
  it("the negotiator propagates common to ancestors (git's): 16 haves even without ready", async () => {
    const src = emptyRepo();
    let stream = "";
    for (let i = 0; i < 300; i++) {
      const data = `c ${i}\n`;
      stream += `commit refs/heads/main\ncommitter c <c@x> ${1700000000 + i} +0000\ndata 2\nc\n`;
      stream += `M 100644 inline f.txt\ndata ${data.length}\n${data}\n`;
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: src, input: stream });
    git(src, ["checkout", "-q", "main"]);
    const url = await serve(uploadPackHandler(await open(src), { neverReady: true }));
    const d = emptyRepo();
    const repo = await open(d);
    await clone(url, repo);
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(src, "new.txt"), `new ${i}\n`);
      commitAll(src, `n${i}`);
    }
    const stats: FetchStats = { haves: 0, rounds: 0, objects: 0 };
    await fetchFrom(url, repo, { refspecs: ["+refs/heads/*:refs/heads/*"], stats });
    expect(stats.haves).toBeLessThanOrEqual(16);
    expect(rev(d, "refs/heads/main")).toBe(rev(src, "HEAD"));
  }, 120_000);
  it("a want reachable from the refs (not a tip) is served, as git v2: fetch by commit id", async () => {
    const src = repoWithHistory(5);
    const url = await serve(uploadPackHandler(await open(src)));
    const sh = emptyRepo();
    await gitAsync(sh, ["fetch", "-q", "--depth", "1", url, rev(src, "HEAD~2")]);
    expect(rev(sh, "FETCH_HEAD")).toBe(rev(src, "HEAD~2"));
  }, 60_000);
  it("one non-fast-forward ref is rejected; the others still update", async () => {
    const src = repoWithHistory(4);
    git(src, ["branch", "b"]);
    const url = await serve(uploadPackHandler(await open(src)));
    const d = emptyRepo();
    const repo = await open(d);
    await fetchFrom(url, repo, { refspecs: ["refs/heads/*:refs/remotes/o/*"] });
    git(src, ["reset", "-q", "--hard", "HEAD~1"]);
    writeFileSync(join(src, "file0.txt"), "rewritten\n");
    commitAll(src, "rewrite main");
    git(src, ["checkout", "-q", "b"]);
    writeFileSync(join(src, "file1.txt"), "b moves on\n");
    commitAll(src, "b forward");
    const r = await fetchFrom(url, repo, { refspecs: ["refs/heads/*:refs/remotes/o/*"] });
    expect(r.rejected.map((x) => x.name)).toEqual(["refs/remotes/o/main"]);
    expect(rev(d, "refs/remotes/o/b")).toBe(rev(src, "refs/heads/b"));
    expect(rev(d, "refs/remotes/o/main")).not.toBe(rev(src, "refs/heads/main"));
  }, 60_000);
  it("a refspec without a destination fetches the objects; an empty remote's clone takes its unborn HEAD", async () => {
    const src = repoWithHistory(3);
    const url = await serve(uploadPackHandler(await open(src)));
    const d = emptyRepo();
    const repo = await open(d);
    await fetchFrom(url, repo, { refspecs: ["refs/heads/main"] });
    expect(
      git(d, ["cat-file", "-t", rev(src, "HEAD")])
        .toString()
        .trim(),
    ).toBe("commit");
    const empty = emptyRepo();
    git(empty, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    const eurl = await serve(uploadPackHandler(await open(empty)));
    const e = emptyRepo();
    await clone(eurl, await open(e));
    expect(git(e, ["symbolic-ref", "HEAD"]).toString().trim()).toBe("refs/heads/trunk");
  }, 60_000);
});
