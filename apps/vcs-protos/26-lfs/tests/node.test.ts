import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, gitEnv, noise } from "../../12-index-pack/src/git-repo.js";
import { sqlRepository } from "../../17-repository/src/repository.js";
import { openRepository } from "../../25-repo-facade/src/vcs.js";
import { lfsFetch, lfsPush, transferHeaders } from "../src/client.js";
import { encodePointer, parsePointer } from "../src/pointer.js";
import { isLfsRequest, lfsHandler, withLfs } from "../src/server.js";
import { clean, type LfsStore, lfsStore, repoLfsStore, smudge } from "../src/store.js";
import { serve } from "./serve.js";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x10a-"));
  dirs.push(d);
  return d;
};
const enc = new TextEncoder();
const dec = new TextDecoder();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const who = { name: "Ada", email: "ada@example.com" };
const filesSpec = (gitDir: string) => ({
  files: new StreamingNodeFilesApi(gitDir),
  refFiles: nodeRefFiles(gitDir),
});
/** git-lfs's filters without a global `git lfs install` */
const LFS = [
  "-c",
  "filter.lfs.clean=git-lfs clean -- %f",
  "-c",
  "filter.lfs.smudge=git-lfs smudge -- %f",
  "-c",
  "filter.lfs.process=git-lfs filter-process",
  "-c",
  "filter.lfs.required=true",
  "-c",
  "lfs.locksverify=false",
];
const lfsGit = (cwd: string, args: string[], input?: string | Uint8Array) =>
  git(cwd, [...LFS, ...args], input);
/** git (with git-lfs) talking to an in-process server: spawned async */
const gitAsync = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("git", [...LFS, ...args], {
      cwd,
      env: { ...gitEnv, NO_PROXY: "127.0.0.1", GIT_TERMINAL_PROMPT: "0" },
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
const collect = async (it: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
};
const ptr = (content: Uint8Array) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${sha(content)}\nsize ${content.length}\n`;
/** a bare repository served with git and LFS on one URL */
async function lfsServer(opts: Parameters<typeof lfsHandler>[1] = {}) {
  const d = join(tmp(), "srv.git");
  mkdirSync(d);
  const v = await openRepository(filesSpec(d), { init: true, identity: who });
  const store = repoLfsStore(v.repo);
  const url = await serve(withLfs(v.serve(), lfsHandler(store, opts)), closers);
  return { d, v, store, url };
}
const lfsJson = {
  "content-type": "application/vnd.git-lfs+json",
  accept: "application/vnd.git-lfs+json",
};
const batch = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/info/lfs/objects/batch`, {
    method: "POST",
    headers: { ...lfsJson, ...headers },
    body: JSON.stringify(body),
  });

describe("R1 pointers and filters", () => {
  it("encodePointer and clean are byte-identical to git-lfs", async () => {
    const d = tmp();
    git(d, ["init", "-q", "w"]);
    const w = join(d, "w");
    const store = lfsStore(new StreamingNodeFilesApi(join(w, ".git")), "");
    const corpus = [
      new Uint8Array(0),
      enc.encode("x"),
      enc.encode("hello\n"),
      noise(70_000, 7),
      noise(3 << 20, 9),
    ];
    for (const [i, content] of corpus.entries()) {
      writeFileSync(join(w, `f${i}`), content);
      // an empty file has no pointer: git-lfs 3.4 prints nothing, newer ones exit 1
      // ("pointer error"); either way the file stays its own, empty, pointer
      const r = spawnSync("git", [...LFS, "lfs", "pointer", `--file=f${i}`], {
        cwd: w,
        env: gitEnv,
      });
      if (r.status !== 0 && content.length) throw new Error(r.stderr.toString());
      const native = r.status === 0 ? r.stdout.toString() : "";
      const nativeClean = lfsGit(w, ["lfs", "clean", "--", `f${i}`], content).toString();
      const ours = await clean(store, [content]);
      expect(dec.decode(ours.pointer), `#${i}`).toBe(native);
      expect(dec.decode(ours.pointer), `#${i}`).toBe(nativeClean);
      if (content.length)
        expect(dec.decode(encodePointer({ oid: sha(content), size: content.length }))).toBe(native);
    }
    expect(encodePointer({ oid: sha(new Uint8Array(0)), size: 0 }).length).toBe(0);
  });

  it("parsePointer accepts exactly what git lfs smudge accepts; smudge as git-lfs", async () => {
    const d = tmp();
    git(d, ["init", "-q", "w"]);
    const w = join(d, "w");
    const content = enc.encode("CONTENT\n");
    lfsGit(w, ["lfs", "clean", "--", "c"], content); // stores the object natively
    const oid = sha(content);
    const v = "version https://git-lfs.github.com/spec/v1";
    const cases = [
      `${v}\noid sha256:${oid}\nsize 8\n`,
      `${v}\noid sha256:${oid}\nsize 8`,
      `${v}\noid sha256:${oid}\nsize 8\n\n`,
      `${v}\r\noid sha256:${oid}\r\nsize 8\r\n`,
      `${v}\nsize 8\noid sha256:${oid}\n`,
      `oid sha256:${oid}\n${v}\nsize 8\n`,
      `${v}\noid sha256:${oid.toUpperCase()}\nsize 8\n`,
      `${v}\noid sha256:${oid.slice(1)}\nsize 8\n`,
      `${v}\noid sha256:${oid}\nsize -8\n`,
      `${v}\noid sha256:${oid}\nsize +8\n`,
      `${v}\noid sha256:${oid}\nsize 08\n`,
      `${v}\noid sha256:${oid}\nsize 8 \n`,
      `${v}\noid sha256:${oid}\nsize 8\nzzz extra\n`,
      `${v}\noid sha256:${oid}\nsize 8\n${"x".repeat(1100)}\n`,
      `version https://hawser.github.com/spec/v1\noid sha256:${oid}\nsize 8\n`,
      `version https://git-lfs.github.com/spec/v2\noid sha256:${oid}\nsize 8\n`,
      `${v}\noid sha256:${oid}\nsize 8\n${" ".repeat(1100)}\ngarbage after the cutoff\n`,
      ` ${v}\noid sha256:${oid}\nsize 8\n`,
      `${v}\noid md5:${oid}\nsize 8\n`,
      `${v}\noid  sha256:${oid}\nsize 8\n`,
      `${v}\noid sha256:${oid}\n`,
      "",
      "plain text\n",
    ];
    // extension lines (git-lfs runs the named extension, so smudge cannot be the oracle here):
    // the spec's example
    const e1 = "1".repeat(64);
    const e2 = "2".repeat(64);
    expect(
      parsePointer(
        enc.encode(
          `${v}\next-0-foo sha256:${e1}\next-1-bar sha256:${e2}\noid sha256:${oid}\nsize 8\n`,
        ),
      ),
    ).toEqual({
      oid,
      size: 8,
      extensions: [
        { priority: 0, name: "foo", oid: e1 },
        { priority: 1, name: "bar", oid: e2 },
      ],
    });
    expect(
      dec.decode(
        encodePointer({
          oid,
          size: 8,
          extensions: [
            { priority: 1, name: "bar", oid: e2 },
            { priority: 0, name: "foo", oid: e1 },
          ],
        }),
      ),
    ).toBe(`${v}\next-0-foo sha256:${e1}\next-1-bar sha256:${e2}\noid sha256:${oid}\nsize 8\n`);
    // git-lfs: nothing, an extension included, after size ("extra line")
    expect(
      parsePointer(enc.encode(`${v}\noid sha256:${oid}\nsize 8\next-0-foo sha256:${e1}\n`)),
    ).toBeUndefined();
    const store = lfsStore(new StreamingNodeFilesApi(join(w, ".git")), "");
    for (const c of cases) {
      const r = spawnSync("git", [...LFS, "lfs", "smudge"], { cwd: w, env: gitEnv, input: c });
      const recognized = r.stdout.toString() !== c;
      const parsed = parsePointer(enc.encode(c));
      expect(parsed !== undefined, JSON.stringify(c)).toBe(recognized);
      // ours: a pointer's content, anything else unchanged
      if (r.status === 0) {
        const out = await collect(smudge(store, enc.encode(c)));
        expect(dec.decode(out), JSON.stringify(c)).toBe(r.stdout.toString());
      }
    }
    // a pointer whose size differs from the object's: refused
    await expect(
      collect(smudge(store, enc.encode(`${v}\noid sha256:${oid}\nsize 9\n`))),
    ).rejects.toThrow();
  });
});

describe("R2 the store in git-lfs's layout", () => {
  it("finds native git-lfs objects; native git-lfs finds ours; verified writes; SQL", async () => {
    const d = tmp();
    git(d, ["init", "-q", "w"]);
    const w = join(d, "w");
    lfsGit(w, ["lfs", "track", "*.bin"]);
    const a = noise(200_000, 1);
    writeFileSync(join(w, "a.bin"), a);
    lfsGit(w, ["add", "-A"]);
    lfsGit(w, ["commit", "-q", "-m", "a"]);
    const store = lfsStore(new StreamingNodeFilesApi(join(w, ".git")), "");
    expect(await store.has(sha(a))).toBe(true);
    expect(await store.size(sha(a))).toBe(a.length);
    expect(sha(await collect(store.read(sha(a))))).toBe(sha(a));
    expect(sha(await collect(store.read(sha(a), { start: 150_000 })))).toBe(
      sha(a.subarray(150_000)),
    );
    // ours, found by git-lfs: a pointer committed natively, its object written by us
    const b = noise(120_000, 2);
    await store.put([b]);
    writeFileSync(join(w, "b.bin"), ptr(b));
    lfsGit(w, ["add", "-A"]);
    lfsGit(w, ["commit", "-q", "-m", "b"]);
    expect(lfsGit(w, ["lfs", "fsck"]).toString()).toContain("Git LFS fsck OK");
    expect(
      readFileSync(
        join(w, ".git", "lfs", "objects", sha(b).slice(0, 2), sha(b).slice(2, 4), sha(b)),
      ),
    ).toEqual(Buffer.from(b));
    // a mismatch is refused; nothing stays
    const c = noise(50_000, 3);
    await expect(store.put([c], { oid: sha(b), size: c.length })).rejects.toThrow();
    await expect(store.put([c], { oid: sha(c), size: c.length + 1 })).rejects.toThrow();
    expect(await store.has(sha(c))).toBe(false);
    for (const sub of ["incomplete", "tmp"]) {
      const dir = join(w, ".git", "lfs", sub);
      // ours (git-lfs keeps its own files in lfs/tmp)
      const ours = (existsSync(dir) ? readdirSync(dir) : []).filter((n) =>
        sub === "tmp" ? /^[0-9a-f]{16}$/.test(n) : true,
      );
      expect(ours, sub).toEqual([]);
    }
    // the SQL repository's files
    const sql = repoLfsStore(await sqlRepository(await newNodeSqliteDb()));
    const p = await sql.put([b.subarray(0, 60_000), b.subarray(60_000)]);
    expect(p).toEqual({ oid: sha(b), size: b.length });
    expect(sha(await collect(sql.read(sha(b))))).toBe(sha(b));
  });
});

describe("R3 the server with native git-lfs", () => {
  it("native push stores verified objects; native clone smudges identical files", async () => {
    const { store, url } = await lfsServer();
    const d = tmp();
    git(d, ["init", "-q", "-b", "main", "w"]);
    const w = join(d, "w");
    lfsGit(w, ["lfs", "track", "*.bin"]);
    const big = noise(3 << 20, 11);
    const small = noise(10_000, 12);
    writeFileSync(join(w, "big.bin"), big);
    writeFileSync(join(w, "small.bin"), small);
    writeFileSync(join(w, "readme.txt"), "not lfs\n");
    lfsGit(w, ["add", "-A"]);
    lfsGit(w, ["commit", "-q", "-m", "files"]);
    await gitAsync(w, ["push", "-q", url, "HEAD:refs/heads/main"]);
    expect(await store.size(sha(big))).toBe(big.length);
    expect(sha(await collect(store.read(sha(small))))).toBe(sha(small));
    const c = join(d, "clone");
    await gitAsync(d, ["clone", "-q", url, c]);
    expect(sha(readFileSync(join(c, "big.bin")))).toBe(sha(big));
    expect(sha(readFileSync(join(c, "small.bin")))).toBe(sha(small));
    expect(readFileSync(join(c, "readme.txt"), "utf8")).toBe("not lfs\n");
    expect(lfsGit(c, ["lfs", "fsck"]).toString()).toContain("Git LFS fsck OK");
  }, 120_000);

  it("batch errors, ranges and verify as the spec says", async () => {
    const { store, url } = await lfsServer();
    const a = noise(100_000, 21);
    await store.put([a]);
    expect(isLfsRequest(new Request(`${url}/info/lfs/objects/batch`, { method: "POST" }))).toBe(
      true,
    );
    expect(isLfsRequest(new Request(`${url}/info/refs?service=git-upload-pack`))).toBe(false);
    const r = await batch(url, {
      operation: "download",
      transfers: ["basic"],
      objects: [
        { oid: sha(a), size: a.length },
        { oid: "1".repeat(64), size: 5 },
        { oid: "xyz", size: 5 },
        { oid: "2".repeat(64), size: -1 },
        { oid: sha(a), size: a.length + 1 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/vnd.git-lfs+json");
    const body = (await r.json()) as {
      transfer: string;
      objects: {
        oid: string;
        actions?: { download?: { href: string } };
        error?: { code: number };
      }[];
    };
    expect(body.transfer).toBe("basic");
    expect(body.objects[0]?.actions?.download?.href).toBeTruthy();
    expect(body.objects.slice(1).map((o) => o.error?.code)).toEqual([404, 422, 422, 422]);
    const href = body.objects[0]?.actions?.download?.href as string;
    const full = await fetch(href);
    expect(full.status).toBe(200);
    expect(sha(new Uint8Array(await full.arrayBuffer()))).toBe(sha(a));
    const part = await fetch(href, { headers: { range: "bytes=90000-" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 90000-99999/${a.length}`);
    expect(sha(new Uint8Array(await part.arrayBuffer()))).toBe(sha(a.subarray(90_000)));
    expect((await fetch(href, { headers: { range: "bytes=100000-" } })).status).toBe(416);
    // upload: an object the server has needs no action; a wrong body is refused
    const up = (await (
      await batch(url, {
        operation: "upload",
        objects: [
          { oid: sha(a), size: a.length },
          { oid: sha(noise(10, 1)), size: 10 },
        ],
      })
    ).json()) as {
      objects: {
        actions?: {
          upload?: { href: string; header?: Record<string, string> };
          verify?: { href: string; header?: Record<string, string> };
        };
      }[];
    };
    expect(up.objects[0]?.actions).toBeUndefined();
    const action = up.objects[1]?.actions?.upload;
    expect(action).toBeDefined();
    const bad = await fetch(action?.href as string, {
      method: "PUT",
      headers: action?.header,
      body: noise(10, 2) as BodyInit,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(await store.has(sha(noise(10, 1)))).toBe(false);
    const good = await fetch(action?.href as string, {
      method: "PUT",
      headers: action?.header,
      body: noise(10, 1) as BodyInit,
    });
    expect(good.status).toBe(200);
    const verify = up.objects[1]?.actions?.verify;
    expect(verify).toBeDefined();
    const vr = await fetch(verify?.href as string, {
      method: "POST",
      headers: { ...lfsJson, ...verify?.header },
      body: JSON.stringify({ oid: sha(noise(10, 1)), size: 10 }),
    });
    expect(vr.status).toBe(200);
    const vm = await fetch(verify?.href as string, {
      method: "POST",
      headers: { ...lfsJson, ...verify?.header },
      body: JSON.stringify({ oid: "3".repeat(64), size: 10 }),
    });
    expect(vm.status).toBe(404);
  });
});

describe("R4 the client", () => {
  it("our push clones natively; native pushes fetch with ours; present objects are skipped", async () => {
    // a repository made with the façade: .gitattributes and a pointer, the content in its store
    const a = join(tmp(), "a.git");
    mkdirSync(a);
    const va = await openRepository(filesSpec(a), { init: true, identity: who });
    const sa = repoLfsStore(va.repo);
    const content = noise(1 << 20, 31);
    const p = await clean(sa, [content]);
    await va.commit({
      files: {
        ".gitattributes": enc.encode("*.bin filter=lfs diff=lfs merge=lfs -text\n"),
        "data.bin": p.pointer,
      },
      message: "lfs\n",
    });
    const { store, url } = await lfsServer();
    const verified: string[] = [];
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname.endsWith("/info/lfs/verify")) verified.push(req.method);
      return fetch(req);
    }) as typeof fetch;
    const stats = { bytes: 0 };
    expect(await lfsPush(url, sa, [{ oid: p.oid, size: p.size }], { stats, fetch: spy })).toEqual({
      uploaded: [p.oid],
      skipped: [],
    });
    expect(stats.bytes).toBe(content.length);
    expect(verified).toEqual(["POST"]);
    await va.push(url, { refspecs: ["refs/heads/main:refs/heads/main"] });
    expect(await store.has(p.oid)).toBe(true);
    expect(await lfsPush(url, sa, [{ oid: p.oid, size: p.size }])).toEqual({
      uploaded: [],
      skipped: [p.oid],
    });
    const c = join(tmp(), "clone");
    await gitAsync(tmpdir(), ["clone", "-q", url, c]);
    expect(sha(readFileSync(join(c, "data.bin")))).toBe(sha(content));
    // the other way: what native git-lfs pushed, our client fetches
    const w = join(tmp(), "w");
    git(tmpdir(), ["init", "-q", "-b", "main", w]);
    lfsGit(w, ["lfs", "track", "*.bin"]);
    const other = noise(700_000, 32);
    writeFileSync(join(w, "o.bin"), other);
    lfsGit(w, ["add", "-A"]);
    lfsGit(w, ["commit", "-q", "-m", "o"]);
    await gitAsync(w, ["push", "-q", url, "HEAD:refs/heads/other"]);
    const fresh = repoLfsStore(
      (await openRepository(filesSpec(join(tmp(), "f.git")), { init: true })).repo,
    );
    expect(await lfsFetch(url, fresh, [{ oid: sha(other), size: other.length }])).toEqual({
      downloaded: [sha(other)],
    });
    expect(sha(await collect(fresh.read(sha(other))))).toBe(sha(other));
    // held already: not asked for again
    const none = (async () => {
      throw new Error("no request expected");
    }) as typeof fetch;
    expect(
      await lfsFetch(url, fresh, [{ oid: sha(other), size: other.length }], { fetch: none }),
    ).toEqual({ downloaded: [] });
  }, 120_000);
});

/** A fetch that passes through `url`'s server but changes the transfer of downloads. */
function tampered(mode: {
  cutAfter?: number;
  ignoreRange?: boolean;
  flip?: boolean;
  short?: boolean;
  /** asks the server for another range than the client did */
  shiftRange?: boolean;
}) {
  const seen: (string | null)[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const isDownload =
      req.method === "GET" && /\/objects\/[0-9a-f]{64}$/.test(new URL(req.url).pathname);
    if (!isDownload) return fetch(req);
    seen.push(req.headers.get("range"));
    const headers = new Headers(req.headers);
    if (mode.ignoreRange) headers.delete("range");
    if (mode.shiftRange && headers.get("range")) headers.set("range", "bytes=1000-");
    const res = await fetch(new Request(req.url, { headers }));
    if (!res.body) return res;
    const reader = res.body.getReader();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const r = await reader.read();
        if (r.done) return ctrl.close();
        let chunk = r.value;
        if (mode.flip && sent === 0) {
          chunk = chunk.slice();
          chunk[0] = (chunk[0] as number) ^ 1;
        }
        if (mode.cutAfter !== undefined && sent + chunk.length > mode.cutAfter) {
          ctrl.enqueue(chunk.subarray(0, mode.cutAfter - sent));
          sent = mode.cutAfter;
          if (mode.short) return ctrl.close();
          return ctrl.error(new Error("connection reset"));
        }
        sent += chunk.length;
        ctrl.enqueue(chunk);
      },
      cancel: (r) => reader.cancel(r),
    });
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return { f, seen };
}

describe("R5 resume and verify", () => {
  it("an interrupted download resumes with Range; a 200 restarts; bad bytes are refused", async () => {
    const { store, url } = await lfsServer();
    const a = noise(4 << 20, 41);
    await store.put([a]);
    const obj = { oid: sha(a), size: a.length };
    const local = repoLfsStore(
      (await openRepository(filesSpec(join(tmp(), "l.git")), { init: true })).repo,
    );
    const cut = tampered({ cutAfter: 3 << 20 });
    await expect(lfsFetch(url, local, [obj], { fetch: cut.f })).rejects.toThrow();
    expect(await local.has(obj.oid)).toBe(false);
    expect(await local.incomplete.size(obj.oid)).toBe(3 << 20);
    const resume = tampered({});
    const stats = { bytes: 0 };
    await lfsFetch(url, local, [obj], { fetch: resume.f, stats });
    expect(resume.seen).toEqual([`bytes=${3 << 20}-`]);
    expect(stats.bytes).toBe(a.length - (3 << 20));
    expect(sha(await collect(local.read(obj.oid)))).toBe(obj.oid);
    expect(await local.incomplete.size(obj.oid)).toBe(0);
    // a backend that drops a failed write still keeps what arrived (MemFilesApi does)
    const mem = lfsStore(new MemFilesApi(), "repo");
    await expect(
      lfsFetch(url, mem, [obj], { fetch: tampered({ cutAfter: 2 << 20 }).f }),
    ).rejects.toThrow();
    expect(await mem.incomplete.size(obj.oid)).toBe(2 << 20);
    // a 206 for another offset than asked: refused, what is held stays
    await expect(
      lfsFetch(url, mem, [obj], { fetch: tampered({ shiftRange: true }).f }),
    ).rejects.toThrow(/resumed at 1000/);
    expect(await mem.incomplete.size(obj.oid)).toBe(2 << 20);
    await lfsFetch(url, mem, [obj]);
    expect(sha(await collect(mem.read(obj.oid)))).toBe(obj.oid);
    // a server that ignores Range: the client starts over and still verifies
    const local2 = repoLfsStore(
      (await openRepository(filesSpec(join(tmp(), "l2.git")), { init: true })).repo,
    );
    await expect(
      lfsFetch(url, local2, [obj], { fetch: tampered({ cutAfter: 1 << 20 }).f }),
    ).rejects.toThrow();
    const stats2 = { bytes: 0 };
    await lfsFetch(url, local2, [obj], { fetch: tampered({ ignoreRange: true }).f, stats: stats2 });
    expect(stats2.bytes).toBe(a.length);
    expect(sha(await collect(local2.read(obj.oid)))).toBe(obj.oid);
    // flipped bytes, or a body that ends early: refused, nothing kept
    for (const mode of [{ flip: true }, { cutAfter: 1000, short: true }]) {
      const l = repoLfsStore(
        (await openRepository(filesSpec(join(tmp(), "l3.git")), { init: true })).repo,
      );
      await expect(lfsFetch(url, l, [obj], { fetch: tampered(mode).f })).rejects.toThrow();
      expect(await l.has(obj.oid)).toBe(false);
      if (mode.flip) expect(await l.incomplete.size(obj.oid)).toBe(0);
    }
  }, 120_000);
});

describe("R6 bounded memory", () => {
  it("256 MiB through clean, store, upload, download and smudge: heap growth < 32 MiB", async () => {
    const size = 256 << 20;
    const chunk = noise(1 << 20, 51);
    const source = async function* () {
      for (let i = 0; i < size >> 20; i++) {
        const c = chunk.slice();
        c[0] = i & 255; // every MiB differs
        yield c;
      }
    };
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    // Uint8Array backing stores are outside the JS heap: both are measured
    const used = () => {
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    const base = used();
    let peak = base;
    // live memory: collected before each sample (garbage awaiting collection is not held)
    const timer = setInterval(() => {
      gc?.();
      peak = Math.max(peak, used());
    }, 50);
    try {
      const a = repoLfsStore(
        (await openRepository(filesSpec(join(tmp(), "m.git")), { init: true })).repo,
      );
      const p = await clean(a, source());
      // the server in-process: Node's fetch (undici 6) holds a streamed request body in memory
      // whatever the server's pace (measured: 129 MiB for 128 MiB), which is not ours to bound
      const store = lfsStore(new StreamingNodeFilesApi(tmp()), "");
      const handler = lfsHandler(store);
      const url = "http://in-process/repo.git";
      const direct = ((input: RequestInfo | URL, init?: RequestInit) =>
        handler(new Request(input, init))) as typeof fetch;
      await lfsPush(url, a, [p], { fetch: direct });
      const b = repoLfsStore(
        (await openRepository(filesSpec(join(tmp(), "n.git")), { init: true })).repo,
      );
      await lfsFetch(url, b, [p], { fetch: direct });
      expect(await store.size(p.oid)).toBe(size);
      const h = createHash("sha256");
      let n = 0;
      for await (const c of smudge(b, p.pointer)) {
        h.update(c);
        n += c.length;
      }
      expect(n).toBe(size);
      expect(h.digest("hex")).toBe(p.oid);
    } finally {
      clearInterval(timer);
    }
    console.log(`R6 heap growth ${((peak - base) / (1 << 20)).toFixed(1)} MiB`);
    expect((peak - base) / (1 << 20)).toBeLessThan(32);
  }, 300_000);
});

describe("R7 access", () => {
  it("401 without credentials, 403 for a reader uploading; transfers need the action's headers", async () => {
    const tokens = new Map<string, string>();
    const { store, url } = await lfsServer({
      authorize: async (req, op) => {
        const auth = req.headers.get("authorization");
        if (!auth) return { status: 401, message: "credentials needed" };
        if (auth === "Basic reader" && op === "upload")
          return { status: 403, message: "read-only" };
        return true;
      },
      transferAuth: {
        headers: async (op, oid) => {
          const t = `${op}-${oid.slice(0, 8)}-${Math.random()}`;
          tokens.set(t, `${op}:${oid}`);
          return { authorization: `Bearer ${t}` };
        },
        check: async (req, op, oid) =>
          tokens.get(req.headers.get("authorization")?.replace("Bearer ", "") ?? "") ===
          `${op}:${oid}`,
      },
    });
    const a = noise(30_000, 61);
    const obj = { oid: sha(a), size: a.length };
    const r401 = await batch(url, { operation: "download", objects: [obj] });
    expect(r401.status).toBe(401);
    expect(r401.headers.get("lfs-authenticate")).toContain("Basic");
    const r403 = await batch(
      url,
      { operation: "upload", objects: [obj] },
      { authorization: "Basic reader" },
    );
    expect(r403.status).toBe(403);
    // a writer's client: the action headers authorize its transfers
    const local = lfsStore(new StreamingNodeFilesApi(tmp()), "");
    await local.put([a]);
    await lfsPush(url, local, [obj], { headers: { authorization: "Basic writer" } });
    expect(await store.has(obj.oid)).toBe(true);
    // a transfer without the action's header, or with another object's, is refused
    const href = `${url}/info/lfs/objects/${obj.oid}`;
    expect((await fetch(href)).status).toBe(401);
    const b = noise(10, 62);
    const other = (await (
      await batch(url, { operation: "download", objects: [obj] }, { authorization: "Basic reader" })
    ).json()) as { objects: { actions: { download: { header: Record<string, string> } } }[] };
    const token = other.objects[0]?.actions.download.header;
    expect((await fetch(href, { headers: token })).status).toBe(200);
    expect((await fetch(`${url}/info/lfs/objects/${sha(b)}`, { headers: token })).status).toBe(401);
    const fetched = lfsStore(new StreamingNodeFilesApi(tmp()), "");
    await lfsFetch(url, fetched, [obj], { headers: { authorization: "Basic reader" } });
    expect(await fetched.has(obj.oid)).toBe(true);
  });
});

describe("R8 inside a Durable Object", () => {
  it("batch, upload and a ranged download over the SQL repository in workerd", async () => {
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
      durableObjects: { REPO: { className: "LfsDo", useSQLite: true } },
    });
    try {
      const r = (await (await mf.dispatchFetch("http://x/run", { method: "POST" })).json()) as {
        error?: string;
        put?: number;
        ranged?: number;
        tailOk?: boolean;
      };
      expect(r).toEqual({ put: 200, ranged: 206, tailOk: true });
    } finally {
      await mf.dispose();
    }
  }, 120_000);
});

void ({} as LfsStore);

// ---- review of #89: each test reproduces one finding ----
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function nativeWork(seed: number) {
  const d = tmp();
  git(d, ["init", "-q", "-b", "main", "w"]);
  const w = join(d, "w");
  lfsGit(w, ["lfs", "track", "*.bin"]);
  const big = noise(1 << 20, seed);
  writeFileSync(join(w, "big.bin"), big);
  lfsGit(w, ["add", "-A"]);
  lfsGit(w, ["commit", "-q", "-m", "a"]);
  return { d, w, big };
}

describe("review #89", () => {
  it("F1 authorize without transferAuth: native git-lfs and our client push and clone", async () => {
    const { store, url } = await lfsServer({
      authorize: async (req) =>
        req.headers.get("authorization") ? true : { status: 401, message: "credentials needed" },
    });
    const { d, w, big } = await nativeWork(71);
    const authed = url.replace("http://", "http://u:p@");
    await gitAsync(w, ["push", "-q", authed, "HEAD:refs/heads/main"]);
    expect(await store.has(sha(big))).toBe(true);
    await gitAsync(d, ["clone", "-q", authed, join(d, "c")]);
    expect(sha(readFileSync(join(d, "c", "big.bin")))).toBe(sha(big));
    // our client: its credentials go with the transfers too
    const local = lfsStore(new MemFilesApi(), "r");
    const other = noise(5000, 72);
    const p = await local.put([other]);
    const headers = { authorization: "Basic dTpw" };
    await lfsPush(url, local, [p], { headers });
    const back = lfsStore(new MemFilesApi(), "r");
    await lfsFetch(url, back, [p], { headers });
    expect(await back.has(p.oid)).toBe(true);
  }, 120_000);

  it("F3 concurrent fetches of one object into one store both succeed", async () => {
    const { store, url } = await lfsServer();
    const a = noise(4 << 20, 73);
    await store.put([a]);
    const obj = { oid: sha(a), size: a.length };
    // a second server over the same store that sends downloads slowly (slowed on the server:
    // a client that holds back a response makes undici assert when the server closes the socket)
    const plain = lfsHandler(store);
    const slowUrl = await serve(async (req) => {
      const res = await plain(req);
      if (!res.body || req.method !== "GET") return res;
      const reader = res.body.getReader();
      return new Response(
        new ReadableStream({
          async pull(c) {
            await sleep(5);
            const r = await reader.read();
            if (r.done) c.close();
            else c.enqueue(r.value);
          },
        }),
        { status: res.status, headers: res.headers },
      );
    }, closers);
    for (const local of [
      lfsStore(new StreamingNodeFilesApi(tmp()), ""),
      lfsStore(new MemFilesApi(), "r"),
    ]) {
      const A = lfsFetch(slowUrl, local, [obj]);
      await sleep(150);
      const B = lfsFetch(url, local, [obj]);
      await Promise.all([A, B]);
      expect(sha(await collect(local.read(obj.oid)))).toBe(obj.oid);
    }
    // parts that do not chain (a gap) count only up to the gap
    const files = new MemFilesApi();
    const gap = lfsStore(files, "r");
    await gap.incomplete.append(
      obj.oid,
      (async function* () {
        yield a.subarray(0, 1000);
      })(),
    );
    await files.write(`r/lfs/incomplete/${obj.oid}/${String(5000).padStart(16, "0")}`, [
      a.subarray(5000, 6000),
    ]);
    expect(await gap.incomplete.size(obj.oid)).toBe(1000);
  }, 120_000);

  it("F4 the client checks the server's answer against what it asked", async () => {
    const empty = (async () =>
      new Response(JSON.stringify({ transfer: "basic", objects: [] }), {
        status: 200,
        headers: { "content-type": "application/vnd.git-lfs+json" },
      })) as typeof fetch;
    const local = lfsStore(new MemFilesApi(), "r");
    const p = await local.put([noise(100, 74)]);
    await expect(
      lfsFetch("http://x/repo.git", lfsStore(new MemFilesApi(), "r"), [p], { fetch: empty }),
    ).rejects.toThrow(/missing/);
    await expect(lfsPush("http://x/repo.git", local, [p], { fetch: empty })).rejects.toThrow(
      /missing/,
    );
  });

  it("F5 F10 the batch is authorized before it is parsed, bounded, and malformed objects are 422", async () => {
    const refused = await lfsServer({
      authorize: async () => ({ status: 401, message: "credentials needed" }),
    });
    for (const body of [
      "{",
      JSON.stringify({ operation: "download", hash_algo: "x", objects: [] }),
    ]) {
      const r = await fetch(`${refused.url}/info/lfs/objects/batch`, {
        method: "POST",
        headers: lfsJson,
        body,
      });
      expect(r.status, body).toBe(401);
    }
    const { url } = await lfsServer();
    const many = Array.from({ length: 1001 }, (_, i) => ({
      oid: sha(enc.encode(String(i))),
      size: 1,
    }));
    expect((await batch(url, { operation: "download", objects: many })).status).toBe(413);
    const huge = await fetch(`${url}/info/lfs/objects/batch`, {
      method: "POST",
      headers: lfsJson,
      body: JSON.stringify({ operation: "download", objects: [], pad: "x".repeat(2 << 20) }),
    });
    expect(huge.status).toBe(413);
    const r = await batch(url, { operation: "download", objects: [null, 5] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { objects: { error?: { code: number } }[] };
    expect(body.objects.map((o) => o.error?.code)).toEqual([422, 422]);
    const vr = await fetch(`${url}/info/lfs/verify`, {
      method: "POST",
      headers: lfsJson,
      body: JSON.stringify({ oid: "1".repeat(64), size: "1000" }),
    });
    expect(vr.status).toBe(422);
  });

  it("F6 F7 held parts survive a failure that is not a mismatch; a failed rename is not success", async () => {
    const a = noise(100_000, 75);
    const obj = { oid: sha(a), size: a.length };
    class Flaky extends MemFilesApi {
      failReads = false;
      failMoves = false;
      override read(path: string, o?: Parameters<MemFilesApi["read"]>[1]) {
        if (this.failReads && path.includes("incomplete"))
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(new Error("transient EIO")),
            }),
          };
        return super.read(path, o);
      }
      override async move(from: string, to: string) {
        return this.failMoves ? false : super.move(from, to);
      }
    }
    const files = new Flaky();
    const store = lfsStore(files, "r");
    await store.incomplete.append(
      obj.oid,
      (async function* () {
        yield a;
      })(),
    );
    files.failReads = true;
    await expect(store.incomplete.complete(obj)).rejects.toThrow(/EIO/);
    expect(await store.incomplete.size(obj.oid)).toBe(a.length);
    files.failReads = false;
    files.failMoves = true;
    await expect(store.put([a])).rejects.toThrow();
    expect(await store.has(obj.oid)).toBe(false);
    files.failMoves = false;
    await store.incomplete.complete(obj);
    expect(await store.has(obj.oid)).toBe(true);
  });

  it("F8 parsePointer agrees with git lfs pointer --check", () => {
    const d = tmp();
    const oid = "a".repeat(64);
    const e1 = "1".repeat(64);
    const e2 = "2".repeat(64);
    const v = "version https://git-lfs.github.com/spec/v1";
    const cases = [
      `${v}\noid sha256:${oid}\nsize 8\n`,
      `version http://git-media.io/v/2\noid sha256:${oid}\nsize 8\n`,
      `\uFEFF${v}\noid sha256:${oid}\nsize 8\n`,
      `${v}\next-0-foo sha256:${e1}\next-0-bar sha256:${e2}\noid sha256:${oid}\nsize 8\n`,
      `${v}\next-0-foo-bar sha256:${e1}\noid sha256:${oid}\nsize 8\n`,
      `${v}\next-10-foo sha256:${e1}\noid sha256:${oid}\nsize 8\n`,
      `${v}\next-0-foo sha256:xyz\noid sha256:${oid}\nsize 8\n`,
      `ext-0-foo sha256:${e1}\n${v}\noid sha256:${oid}\nsize 8\n`,
      `${v}\next-0-foo sha256:${e1}\next-0-foo sha256:${e2}\noid sha256:${oid}\nsize 8\n`,
      `${v}\noid sha256:${oid}\nsize -0\n`,
      `${v}\noid\tsha256:${oid}\nsize 8\n`,
      `\t${v}\noid sha256:${oid}\nsize 8\n`,
      `\u0085${v}\noid sha256:${oid}\nsize 8\n`,
      `\u00A0${v}\noid sha256:${oid}\nsize 8\n`,
      `${v}\noid sha256:${oid}\nsize 8\v`,
      `${v}\roid sha256:${oid}\rsize 8\r`,
      `${v}\r\r\noid sha256:${oid}\nsize 8\n`,
      `${v}\noid sha256:${oid}\nsize 1_0\n`,
      `${v}\noid sha256:${oid}\nsize 0x8\n`,
      `${v}\noid sha256:${oid}\nsize 0\n`,
      `${v}\noid sha256:${oid}\nsize \n`,
      `version \noid sha256:${oid}\nsize 8\n`,
      `${v}\noid\nsize 8\n`,
      `${v}\noid sha256:${oid}\nsize 8\u2028`,
      `${v}\noid sha256:${"z".repeat(64)}\nsize 8\n`,
    ];
    const wrong: string[] = [];
    for (const c of cases) {
      writeFileSync(join(d, "p"), c);
      const native =
        spawnSync("git", ["lfs", "pointer", "--check", "--file=p"], { cwd: d, env: gitEnv })
          .status === 0;
      if ((parsePointer(enc.encode(c)) !== undefined) !== native) wrong.push(JSON.stringify(c));
    }
    expect(wrong).toEqual([]);
    // a repeated extension key: the last one, as git-lfs
    expect(
      parsePointer(
        enc.encode(
          `${v}\next-0-foo sha256:${e1}\next-0-foo sha256:${e2}\noid sha256:${oid}\nsize 8\n`,
        ),
      )?.extensions,
    ).toEqual([{ priority: 0, name: "foo", oid: e2 }]);
  });

  it("F9 ranges as RFC 9110: suffix ranges; unusable ones ignored; If-Range by the oid's ETag", async () => {
    const { store, url } = await lfsServer();
    const a = noise(1000, 76);
    await store.put([a]);
    const href = `${url}/info/lfs/objects/${sha(a)}`;
    const tail = await fetch(href, { headers: { range: "bytes=-10" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 990-999/1000");
    expect(sha(new Uint8Array(await tail.arrayBuffer()))).toBe(sha(a.subarray(990)));
    for (const range of ["bytes=0-0,5-6", "items=0-", "bytes=5-3"]) {
      const r = await fetch(href, { headers: { range } });
      expect(r.status, range).toBe(200);
      expect((await r.arrayBuffer()).byteLength).toBe(1000);
    }
    const full = await fetch(href);
    expect(full.headers.get("etag")).toBe(`"${sha(a)}"`);
    await full.arrayBuffer();
    expect(
      (await fetch(href, { headers: { range: "bytes=10-", "if-range": `"${sha(a)}"` } })).status,
    ).toBe(206);
    expect(
      (await fetch(href, { headers: { range: "bytes=10-", "if-range": '"stale"' } })).status,
    ).toBe(200);
  });

  it("F11 PUT checks Content-Length and the size limit", async () => {
    const { store, url } = await lfsServer({ maxObjectSize: 1000 });
    const a = noise(2000, 77);
    const up = (await (
      await batch(url, { operation: "upload", objects: [{ oid: sha(a), size: a.length }] })
    ).json()) as {
      objects: { error?: { code: number } }[];
    };
    expect(up.objects[0]?.error?.code).toBe(422);
    const href = `${url}/info/lfs/objects/${sha(a)}`;
    const chunked = await fetch(href, {
      method: "PUT",
      body: new ReadableStream({
        start(c) {
          c.enqueue(a);
          c.close();
        },
      }),
      // @ts-expect-error duplex for a streamed body
      duplex: "half",
    });
    expect(chunked.status).toBe(413);
    expect(await store.has(sha(a))).toBe(false);
    const handler = lfsHandler(store);
    const bad = await handler(
      new Request(href, {
        method: "PUT",
        headers: { "content-length": "abc" },
        body: a as BodyInit,
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("F12 duplicate pointers are fetched once; publicUrl sets the hrefs", async () => {
    const { store, url } = await lfsServer();
    const a = noise(50_000, 78);
    await store.put([a]);
    const p = { oid: sha(a), size: a.length };
    const stats = { bytes: 0 };
    const local = lfsStore(new MemFilesApi(), "r");
    expect(await lfsFetch(url, local, [p, p], { stats })).toEqual({ downloaded: [p.oid] });
    expect(stats.bytes).toBe(a.length);
    const h = lfsHandler(store, { publicUrl: "https://git.example.com/team/repo.git" });
    const r = (await (
      await h(
        new Request("http://internal:8080/repo.git/info/lfs/objects/batch", {
          method: "POST",
          headers: lfsJson,
          body: JSON.stringify({ operation: "download", objects: [p] }),
        }),
      )
    ).json()) as { objects: { actions: { download: { href: string } } }[] };
    expect(r.objects[0]?.actions.download.href).toBe(
      `https://git.example.com/team/repo.git/info/lfs/objects/${p.oid}`,
    );
  });
});

describe("found against Gitea (28)", () => {
  it("an action's Authorization replaces the client's authorization: one header, not two joined", () => {
    const h = transferHeaders(
      { oid: "1".repeat(64), size: 1 },
      { href: "http://x", header: { Authorization: "Basic action" } },
      { headers: { authorization: "Basic client", "x-other": "kept" } },
    );
    expect(h).toEqual({ authorization: "Basic action", "x-other": "kept" });
  });
});
