import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { gitEnv, noise, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { log } from "../../17-repository/src/commands.js";
import { clone } from "../../21-smart-http/src/client.js";
import { push } from "../../22-receive-pack/src/client.js";
import { openRepository } from "../../25-repo-facade/src/vcs.js";
import { lfsFetch, lfsPush } from "../../26-lfs/src/client.js";
import { lfsHandler, withLfs } from "../../26-lfs/src/server.js";
import { clean, lfsStore, repoLfsStore } from "../../26-lfs/src/store.js";
import { serve } from "../../26-lfs/tests/serve.js";
import { lfsFetchFrom } from "../../27-lfs-p2p/src/swarm.js";
import { type Gitea, startGitea } from "./gitea.js";

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
let gitea: Gitea;
beforeAll(async () => {
  gitea = await startGitea();
}, 600_000);
afterAll(async () => {
  for (const s of stops) await s().catch(() => {});
  await gitea?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x10b-"));
  dirs.push(d);
  return d;
};
const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const who = { name: "Ada", email: "ada@example.com" };
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
/** native git against Gitea (an external process: a synchronous call is fine) */
const git = (cwd: string, args: string[]) =>
  execFileSync("git", [...LFS, ...args], {
    cwd,
    env: { ...gitEnv, GIT_TERMINAL_PROMPT: "0", NO_PROXY: "127.0.0.1" },
    maxBuffer: 1 << 30,
  }).toString();
const freshRepo = async () => {
  const d = join(tmp(), "r.git");
  mkdirSync(d);
  return {
    d,
    v: await openRepository(
      { files: new StreamingNodeFilesApi(d), refFiles: nodeRefFiles(d) },
      { init: true, identity: who },
    ),
  };
};
const collect = async (it: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
};
const auth = () => ({ authorization: gitea.authorization });
let repoCount = 0;
const newRepo = () => gitea.createRepo(`r${++repoCount}`);

describe("G1 git over smart HTTP v2", () => {
  it("our clone of a natively pushed repository; our push, cloned natively; no credentials refused", async () => {
    const url = await newRepo();
    const src = repoWithHistory(6);
    git(src, ["push", "-q", gitea.withCredentials(url), "HEAD:refs/heads/main"]);
    const { v } = await freshRepo();
    await clone(url, v.repo, { fetch: gitea.fetch });
    expect(await log(v.repo, "HEAD")).toEqual(git(src, ["rev-list", "HEAD"]).trim().split("\n"));
    // our push
    const { v: mine } = await freshRepo();
    await mine.commit({ files: { "a.txt": enc.encode("ours\n") }, message: "ours\n" });
    await mine.commit({
      files: { "a.txt": enc.encode("ours 2\n"), "b.txt": enc.encode("b\n") },
      message: "ours 2\n",
    });
    const url2 = await newRepo();
    const r = await push(url2, mine.repo, {
      fetch: gitea.fetch,
      refspecs: ["refs/heads/main:refs/heads/main"],
    });
    expect(r).toEqual([{ ref: "refs/heads/main", ok: true }]);
    const c = join(tmp(), "c");
    git(tmpdir(), ["clone", "-q", gitea.withCredentials(url2), c]);
    expect(git(c, ["rev-list", "HEAD"]).trim().split("\n")).toEqual(await log(mine.repo, "HEAD"));
    git(c, ["fsck", "--strict"]);
    // no credentials
    await expect(
      push(url2, mine.repo, { refspecs: ["refs/heads/main:refs/heads/other"] }),
    ).rejects.toThrow(/HTTP 401\b/);
  }, 180_000);
});

describe("G2 our LFS upload, cloned natively", () => {
  it("a façade commit with a pointer: native clone from Gitea smudges it; a second push sends nothing", async () => {
    const url = await newRepo();
    const { v } = await freshRepo();
    const store = repoLfsStore(v.repo);
    const content = noise(3 << 20, 1);
    const p = await clean(store, [content]);
    await v.commit({
      files: {
        ".gitattributes": enc.encode("*.bin filter=lfs diff=lfs merge=lfs -text\n"),
        "big.bin": p.pointer,
      },
      message: "lfs\n",
    });
    const stats = { bytes: 0, requests: 0 };
    expect(await lfsPush(url, store, [p], { headers: auth(), stats })).toEqual({
      uploaded: [p.oid],
      skipped: [],
    });
    expect(stats.bytes).toBe(p.size);
    expect(stats.requests).toBe(2); // the PUT, then Gitea's verify action
    await v.push(url, { refspecs: ["refs/heads/main:refs/heads/main"], fetch: gitea.fetch });
    const c = join(tmp(), "c");
    git(tmpdir(), ["clone", "-q", gitea.withCredentials(url), c]);
    expect(sha(readFileSync(join(c, "big.bin")))).toBe(p.oid);
    expect(git(c, ["lfs", "fsck"])).toContain("Git LFS fsck OK");
    expect(await lfsPush(url, store, [p], { headers: auth() })).toEqual({
      uploaded: [],
      skipped: [p.oid],
    });
  }, 180_000);
});

describe("G3 native LFS upload, our download", () => {
  it("lfsFetch stores what git-lfs pushed; a cut download resumes with a 206 from Gitea", async () => {
    const url = await newRepo();
    const w = join(tmp(), "w");
    git(tmpdir(), ["init", "-q", "-b", "main", w]);
    git(w, ["lfs", "track", "*.bin"]);
    const big = noise(4 << 20, 2);
    writeFileSync(join(w, "n.bin"), big);
    git(w, ["add", "-A"]);
    git(w, ["commit", "-q", "-m", "n"]);
    git(w, ["push", "-q", gitea.withCredentials(url), "HEAD:refs/heads/main"]);
    const obj = { oid: sha(big), size: big.length };
    const whole = lfsStore(new MemFilesApi(), "r");
    // a private repository: no credentials, no batch
    await expect(lfsFetch(url, lfsStore(new MemFilesApi(), "r"), [obj])).rejects.toThrow(
      /HTTP 401\b/,
    );
    await lfsFetch(url, whole, [obj], { headers: auth() });
    expect(sha(await collect(whole.read(obj.oid)))).toBe(obj.oid);
    // cut after 1 MiB, then resumed
    const store = lfsStore(new StreamingNodeFilesApi(tmp()), "");
    const ranges: (string | null)[] = [];
    let cut = true;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const res = await fetch(req);
      if (req.method !== "GET" || !res.body) return res;
      ranges.push(req.headers.get("range"));
      if (!cut) return res;
      cut = false;
      const reader = res.body.getReader();
      let sent = 0;
      return new Response(
        new ReadableStream({
          async pull(c) {
            const r = await reader.read();
            if (r.done || sent >= 1 << 20) {
              await reader.cancel();
              return c.error(new Error("link lost"));
            }
            sent += r.value.length;
            c.enqueue(r.value);
          },
        }),
        { status: res.status, headers: res.headers },
      );
    }) as typeof fetch;
    const s1 = { bytes: 0 };
    await expect(
      lfsFetch(url, store, [obj], { headers: auth(), fetch: f, stats: s1 }),
    ).rejects.toThrow();
    const s2 = { bytes: 0 };
    let status = 0;
    let contentRange = "";
    const watch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await f(input, init);
      if (new Request(input, init).method === "GET") {
        status = res.status;
        contentRange = res.headers.get("content-range") ?? "";
      }
      return res;
    }) as typeof fetch;
    await lfsFetch(url, store, [obj], { headers: auth(), fetch: watch, stats: s2 });
    expect(ranges[1]).toMatch(/^bytes=\d+-$/);
    expect(status).toBe(206);
    // Gitea 1.22 reports the total as size − start (bytes 1048576-4194303/3145728): the client
    // must read the start only
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    const start = Number(m?.[1]);
    expect(start).toBe(s1.bytes);
    expect([obj.size, obj.size - start]).toContain(Number(m?.[3]));
    expect(s1.bytes + s2.bytes).toBe(obj.size);
    expect(sha(await collect(store.read(obj.oid)))).toBe(obj.oid);
  }, 180_000);
});

describe("G4 verification and errors", () => {
  it("missing objects are not found; altered bytes refused; Gitea refuses bytes that are not their oid", async () => {
    const url = await newRepo();
    await expect(
      lfsFetch(url, lfsStore(new MemFilesApi(), "r"), [{ oid: "1".repeat(64), size: 10 }], {
        headers: auth(),
      }),
    ).rejects.toThrow(/not found/);
    const { v } = await freshRepo();
    const store = repoLfsStore(v.repo);
    const p = await store.put([noise(200_000, 3)]);
    await lfsPush(url, store, [p], { headers: auth() });
    const flip = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const res = await fetch(req);
      if (req.method !== "GET") return res;
      const b = new Uint8Array(await res.arrayBuffer());
      b[0] = (b[0] as number) ^ 1;
      return new Response(b, { status: res.status, headers: res.headers });
    }) as typeof fetch;
    const target = lfsStore(new MemFilesApi(), "r");
    await expect(lfsFetch(url, target, [p], { headers: auth(), fetch: flip })).rejects.toThrow();
    expect(await target.has(p.oid)).toBe(false);
    // bytes that are not their oid, uploaded straight to Gitea's href
    const wrong = noise(1000, 4);
    const claimed = sha(noise(1000, 5));
    const batch = (await (
      await gitea.fetch(`${url}/info/lfs/objects/batch`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.git-lfs+json",
          accept: "application/vnd.git-lfs+json",
        },
        body: JSON.stringify({ operation: "upload", objects: [{ oid: claimed, size: 1000 }] }),
      })
    ).json()) as {
      objects: { actions: { upload: { href: string; header: Record<string, string> } } }[];
    };
    const up = batch.objects[0]?.actions.upload;
    const r = await fetch(up?.href as string, {
      method: "PUT",
      headers: up?.header,
      body: wrong as BodyInit,
    });
    expect(r.status).toBe(422); // "content hash does not match OID"
    await expect(
      lfsFetch(url, lfsStore(new MemFilesApi(), "r"), [{ oid: claimed, size: 1000 }], {
        headers: auth(),
      }),
    ).rejects.toThrow(/not found/);
  }, 180_000);
});

describe("G5 many sources", () => {
  it("one object held by Gitea and by our server: chunks come from both", async () => {
    const url = await newRepo();
    const content = noise(4 << 20, 6);
    const ours = await freshRepo();
    const oursStore = repoLfsStore(ours.v.repo);
    const p = await oursStore.put([content]);
    await lfsPush(url, oursStore, [p], { headers: auth() });
    const ourUrl = await serve(
      withLfs(ours.v.serve(), lfsHandler(oursStore, { ranged: true })),
      stops,
    );
    const stats: Record<string, number> = {};
    const dest = lfsStore(new StreamingNodeFilesApi(tmp()), "");
    expect(
      await lfsFetchFrom(
        [
          { name: "gitea", url, headers: auth() },
          { name: "peer", url: ourUrl },
        ],
        dest,
        [p],
        { chunkSize: 512 << 10, stats },
      ),
    ).toEqual({ downloaded: [p.oid], bad: [] });
    expect(stats.gitea).toBeGreaterThan(0);
    expect(stats.peer).toBeGreaterThan(0);
    expect((stats.gitea ?? 0) + (stats.peer ?? 0)).toBe(p.size);
    expect(sha(await collect(dest.read(p.oid)))).toBe(p.oid);
  }, 180_000);
});
