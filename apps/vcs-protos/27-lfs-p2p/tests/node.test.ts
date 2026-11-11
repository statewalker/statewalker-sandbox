import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigner, mintToken } from "@statewalker/httpeers-access/issuer";
import { createRemoteOverLink, serveFetchOverLink } from "@statewalker/httpeers-bridge";
import { pairedLinks } from "@statewalker/httpeers-bridge/ports";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, gitEnv, noise } from "../../12-index-pack/src/git-repo.js";
import { log } from "../../17-repository/src/commands.js";
import { clone } from "../../21-smart-http/src/client.js";
import { push } from "../../22-receive-pack/src/client.js";
import { gitRules, meshFetch } from "../../23-git-httpeers/src/mesh-git.js";
import { openRepository } from "../../25-repo-facade/src/vcs.js";
import { lfsFetch, lfsPush } from "../../26-lfs/src/client.js";
import { lfsHandler, withLfs } from "../../26-lfs/src/server.js";
import { clean, type LfsStore, lfsStore, repoLfsStore } from "../../26-lfs/src/store.js";
import { serve } from "../../26-lfs/tests/serve.js";
import { meshLfsHandler, meshRepoHandler } from "../src/mesh-lfs.js";
import { lfsFetchFrom } from "../src/swarm.js";

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const s of stops) await s().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x12-"));
  dirs.push(d);
  return d;
};
const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const who = { name: "Ada", email: "ada@example.com" };
const URL_ = "http://peer.local/repo.git";
const filesSpec = (gitDir: string) => ({
  files: new StreamingNodeFilesApi(gitDir),
  refFiles: nodeRefFiles(gitDir),
});
const collect = async (it: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
};
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
const gitAsync = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("git", [...LFS, ...args], {
      cwd,
      env: { ...gitEnv, NO_PROXY: "127.0.0.1", GIT_TERMINAL_PROMPT: "0" },
    });
    const err: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code) =>
      code === 0 ? resolve("") : reject(new Error(`git ${args.join(" ")}: ${Buffer.concat(err)}`)),
    );
  });
const freshRepo = async () => {
  const d = join(tmp(), "r.git");
  mkdirSync(d);
  return openRepository(filesSpec(d), { init: true, identity: who });
};
/** a store on disk (no MemFilesApi: memory tests) */
const diskStore = () => lfsStore(new StreamingNodeFilesApi(tmp()), "");

/** A mesh: peers serving `handler`s, callers connected to them by name with tokens. */
async function mesh(opts: { requestTimeoutMs?: number } = {}) {
  const signer = await generateSigner();
  const serving = new Map<string, (req: Request) => Promise<Response>>();
  const connect = async (from: string, to: string) => {
    const handler = serving.get(to);
    if (!handler) throw new Error(`no peer ${to}`);
    const [mine, theirs] = pairedLinks(from, to);
    stops.push(await serveFetchOverLink({ link: theirs, dispatch: handler }));
    return createRemoteOverLink({ link: mine, requestTimeoutMs: opts.requestTimeoutMs });
  };
  const client = async (from: string, to: string, roles: string[]) =>
    meshFetch(
      await connect(from, to),
      to,
      await mintToken({ signer, sub: from, roles, ttlMs: 60_000 }),
    );
  return { signer, serving, connect, client };
}

/** a fetch whose transfer requests (to …/objects/<oid>) go through `edit` */
function onTransfers(
  f: typeof fetch,
  edit: (req: Request, n: number) => Promise<Request | Response> | Request | Response,
) {
  let n = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, { ...init, duplex: "half" } as RequestInit);
    if (!/\/objects\/[0-9a-f]{64}$/.test(new URL(req.url).pathname)) return f(req);
    const out = await edit(req, n++);
    return out instanceof Response ? out : f(out);
  }) as typeof fetch;
}
/** `body` at about `bytesPerSecond` */
function throttle(body: ReadableStream<Uint8Array>, bytesPerSecond: number) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const r = await reader.read();
      if (r.done) return c.close();
      for (let i = 0; i < r.value.length; i += 64 << 10) {
        const part = r.value.subarray(i, i + (64 << 10));
        await sleep((part.length / bytesPerSecond) * 1000);
        c.enqueue(part);
      }
    },
  });
}

describe("R1 LFS on the mesh", () => {
  it("an admin pushes git and LFS; a member clones and fetches back; roles hold", async () => {
    const m = await mesh();
    const b = await freshRepo();
    m.serving.set("B", meshRepoHandler(b.repo, { issuer: m.signer.mesh, rules: gitRules() }));
    // A: a commit with a pointer, its content in A's store
    const a = await freshRepo();
    const sa = repoLfsStore(a.repo);
    const content = noise(3 << 20, 1);
    const p = await clean(sa, [content]);
    await a.commit({
      files: {
        ".gitattributes": enc.encode("*.bin filter=lfs diff=lfs merge=lfs -text\n"),
        "big.bin": p.pointer,
      },
      message: "lfs\n",
    });
    const admin = await m.client("A", "B", ["admin"]);
    await lfsPush(URL_, sa, [p], { fetch: admin });
    await push(URL_, a.repo, { fetch: admin, refspecs: ["refs/heads/main:refs/heads/main"] });
    // C, a member: clone, then the LFS object
    const c = await freshRepo();
    const member = await m.client("C", "B", ["member"]);
    await clone(URL_, c.repo, { fetch: member });
    expect(await log(c.repo, "refs/remotes/origin/main")).toEqual(await log(a.repo, "HEAD"));
    const sc = repoLfsStore(c.repo);
    await lfsFetch(URL_, sc, [p], { fetch: member });
    expect(sha(await collect(sc.read(p.oid)))).toBe(p.oid);
    // roles: no token; a member uploading; hidden downloading; contributors
    const anon = await m.connect("Z", "B");
    const r401 = await anon(
      "B",
      new Request(`${URL_}/info/lfs/objects/batch`, {
        method: "POST",
        headers: { "content-type": "application/vnd.git-lfs+json" },
        body: JSON.stringify({ operation: "download", objects: [p] }),
      }),
    );
    expect(r401.status).toBe(401);
    const other = await lfsStore(new MemFilesApi(), "r").put([noise(1000, 2)]);
    const ms = lfsStore(new MemFilesApi(), "r");
    await ms.put([noise(1000, 2)]);
    await expect(lfsPush(URL_, ms, [other], { fetch: member })).rejects.toThrow(/403/);
    const hidden = await m.client("H", "B", ["hidden"]);
    await lfsFetch(URL_, lfsStore(new MemFilesApi(), "r"), [p], { fetch: hidden });
    m.serving.set(
      "B2",
      meshLfsHandler(repoLfsStore(b.repo), {
        issuer: m.signer.mesh,
        rules: gitRules({ contributors: true }),
      }),
    );
    const contributor = await m.client("C", "B2", ["member"]);
    expect(await lfsPush(URL_, ms, [other], { fetch: contributor })).toEqual({
      uploaded: [other.oid],
      skipped: [],
    });
  }, 120_000);
});

describe("R2 the ranged adapter, negotiated", () => {
  it("ranged when offered, basic otherwise; native git-lfs still works; fallback to basic servers", async () => {
    const v = await freshRepo();
    const store = repoLfsStore(v.repo);
    const url = await serve(withLfs(v.serve(), lfsHandler(store, { ranged: true })), stops);
    const batch = async (transfers: string[]) =>
      (
        (await (
          await fetch(`${url}/info/lfs/objects/batch`, {
            method: "POST",
            headers: { "content-type": "application/vnd.git-lfs+json" },
            body: JSON.stringify({
              operation: "upload",
              transfers,
              objects: [{ oid: "1".repeat(64), size: 5 }],
            }),
          })
        ).json()) as { transfer: string }
      ).transfer;
    expect(await batch(["ranged", "basic"])).toBe("ranged");
    expect(await batch(["basic"])).toBe("basic");
    // ranged parts: out of order, then HEAD reports what is held, the last part completes it
    const a = noise(3 << 20, 3);
    const href = `${url}/info/lfs/objects/${sha(a)}`;
    const part = (s: number, e: number) =>
      fetch(href, {
        method: "PUT",
        headers: { "content-range": `bytes ${s}-${e - 1}/${a.length}` },
        body: a.subarray(s, e) as BodyInit,
      });
    expect((await part(2 << 20, 3 << 20)).status).toBe(200);
    expect((await part(0, 1 << 20)).status).toBe(200);
    const head = await fetch(href, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(head.headers.get("x-lfs-held")).toBe(`0-${(1 << 20) - 1},${2 << 20}-${(3 << 20) - 1}`);
    expect(await store.has(sha(a))).toBe(false);
    const last = await part(1 << 20, 2 << 20);
    expect(last.status).toBe(200);
    expect(last.headers.get("x-lfs-complete")).toBe("true");
    expect(sha(await collect(store.read(sha(a))))).toBe(sha(a));
    // a part that does not match its range is refused
    const b = noise(2000, 4);
    const bad = await fetch(`${url}/info/lfs/objects/${sha(b)}`, {
      method: "PUT",
      headers: { "content-range": `bytes 0-999/2000` },
      body: b.subarray(0, 500) as BodyInit,
    });
    expect(bad.status).toBe(400);
    // native git-lfs over plain HTTP against the same handler
    const d = tmp();
    git(d, ["init", "-q", "-b", "main", "w"]);
    const w = join(d, "w");
    git(w, [...LFS, "lfs", "track", "*.bin"]);
    const nat = noise(2 << 20, 5);
    writeFileSync(join(w, "n.bin"), nat);
    git(w, [...LFS, "add", "-A"]);
    git(w, [...LFS, "commit", "-q", "-m", "n"]);
    await gitAsync(w, ["push", "-q", url, "HEAD:refs/heads/main"]);
    await gitAsync(d, ["clone", "-q", url, join(d, "c")]);
    expect(sha(readFileSync(join(d, "c", "n.bin")))).toBe(sha(nat));
    // our client against a basic-only server
    const basicOnly = await freshRepo();
    const basicUrl = await serve(
      withLfs(basicOnly.serve(), lfsHandler(repoLfsStore(basicOnly.repo))),
      stops,
    );
    const local = diskStore();
    const q = await local.put([noise(1 << 20, 6)]);
    expect(await lfsPush(basicUrl, local, [q], { chunkSize: 256 << 10 })).toEqual({
      uploaded: [q.oid],
      skipped: [],
    });
  }, 120_000);
});

describe("R3 the bridge's bound on a response head", () => {
  it("a basic upload over 3 s fails at a 1.5 s timeout; ranged 1 MiB chunks succeed", async () => {
    const m = await mesh({ requestTimeoutMs: 1500 });
    const b = await freshRepo();
    const sb = repoLfsStore(b.repo);
    m.serving.set("B", meshLfsHandler(sb, { issuer: m.signer.mesh, rules: gitRules() }));
    const local = diskStore();
    const content = noise(6 << 20, 7);
    const p = await local.put([content]);
    const slow = (f: typeof fetch) =>
      onTransfers(f, (req) =>
        req.method === "PUT" && req.body
          ? new Request(req, { body: throttle(req.body, 2 << 20), duplex: "half" } as RequestInit)
          : req,
      );
    const admin = await m.client("A", "B", ["admin"]);
    // basic: one PUT of 6 MiB at 2 MiB/s
    const basicOnly = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, { ...init, duplex: "half" } as RequestInit);
      if (!req.url.endsWith("/objects/batch")) return admin(req);
      const body = JSON.parse(await req.text()) as { transfers?: string[] };
      body.transfers = ["basic"];
      return admin(
        new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body) }),
      );
    }) as typeof fetch;
    await expect(lfsPush(URL_, local, [p], { fetch: slow(basicOnly) })).rejects.toThrow();
    expect(await sb.has(p.oid)).toBe(false);
    const stats = { bytes: 0, requests: 0 };
    await lfsPush(URL_, local, [p], { fetch: slow(admin), chunkSize: 1 << 20, stats });
    expect(sha(await collect(sb.read(p.oid)))).toBe(p.oid);
    expect(stats.requests).toBeGreaterThanOrEqual(6);
  }, 120_000);
});

describe("R4 only missing chunks; resume", () => {
  it("an upload cut after 2 of 6 chunks sends the other 4; a cut download resumes from what it holds", async () => {
    const m = await mesh();
    const b = await freshRepo();
    const sb = repoLfsStore(b.repo);
    m.serving.set("B", meshLfsHandler(sb, { issuer: m.signer.mesh, rules: gitRules() }));
    const admin = await m.client("A", "B", ["admin"]);
    const local = diskStore();
    const content = noise(6 << 20, 8);
    const p = await local.put([content]);
    const cut = onTransfers(admin, (req, n) =>
      req.method === "PUT" && n >= 3 ? new Response("cut", { status: 503 }) : req,
    );
    // requests: HEAD (0), PUT (1), PUT (2), then the third PUT is cut
    await expect(lfsPush(URL_, local, [p], { fetch: cut, chunkSize: 1 << 20 })).rejects.toThrow();
    expect(await sb.has(p.oid)).toBe(false);
    const stats = { bytes: 0, requests: 0 };
    let puts = 0;
    const counting = onTransfers(admin, (req) => {
      if (req.method === "PUT") puts++;
      return req;
    });
    await lfsPush(URL_, local, [p], { fetch: counting, chunkSize: 1 << 20, stats });
    expect(puts).toBe(4);
    expect(stats.bytes).toBe(4 << 20);
    expect(sha(await collect(sb.read(p.oid)))).toBe(p.oid);
    // a download cut part-way: the bytes over both attempts are the object's size
    const reader = await m.client("D", "B", ["member"]);
    const dest = diskStore();
    const got: Record<string, number> = {};
    const cutDownload = onTransfers(reader, async (req, n) => {
      if (n < 2) return req;
      const res = await reader(req);
      const r = res.body?.getReader();
      let sent = 0;
      return new Response(
        new ReadableStream({
          async pull(c) {
            const x = await r?.read();
            if (!x || x.done) return c.close();
            if (sent > 300_000) return c.error(new Error("link lost"));
            sent += x.value.length;
            c.enqueue(x.value);
          },
        }),
        { status: res.status, headers: res.headers },
      );
    });
    await expect(
      lfsFetchFrom([{ name: "B", url: URL_, fetch: cutDownload }], dest, [p], {
        chunkSize: 1 << 20,
        stats: got,
      }),
    ).rejects.toThrow();
    const first = got.B ?? 0;
    expect(first).toBeGreaterThan(2 << 20);
    const again: Record<string, number> = {};
    await lfsFetchFrom([{ name: "B", url: URL_, fetch: reader }], dest, [p], {
      chunkSize: 1 << 20,
      stats: again,
    });
    expect(first + (again.B ?? 0)).toBe(p.size);
    expect(sha(await collect(dest.read(p.oid)))).toBe(p.oid);
  }, 120_000);
});

/** two peers holding `content`, and their fetches for a reader D */
async function twoHolders(content: Uint8Array) {
  const m = await mesh();
  const stores: LfsStore[] = [];
  for (const name of ["B", "C"]) {
    const s = diskStore();
    await s.put([content]);
    stores.push(s);
    m.serving.set(name, meshLfsHandler(s, { issuer: m.signer.mesh, rules: gitRules() }));
  }
  return {
    m,
    B: await m.client("D", "B", ["member"]),
    C: await m.client("D", "C", ["member"]),
  };
}

describe("R5 many sources", () => {
  it("both holders serve chunks; one failing leaves the rest to the other; no byte twice", async () => {
    const content = noise(8 << 20, 9);
    const p = { oid: sha(content), size: content.length };
    const { B, C } = await twoHolders(content);
    const stats: Record<string, number> = {};
    const dest = diskStore();
    expect(
      await lfsFetchFrom(
        [
          { name: "B", url: URL_, fetch: B },
          { name: "C", url: URL_, fetch: C },
        ],
        dest,
        [p],
        { chunkSize: 1 << 20, stats },
      ),
    ).toEqual({ downloaded: [p.oid], bad: [] });
    expect(stats.B).toBeGreaterThan(0);
    expect(stats.C).toBeGreaterThan(0);
    expect((stats.B ?? 0) + (stats.C ?? 0)).toBe(p.size);
    expect(sha(await collect(dest.read(p.oid)))).toBe(p.oid);
    // C fails after two chunks: B serves the rest
    const failing = onTransfers(C, (req, n) =>
      n >= 2 ? new Response("gone", { status: 502 }) : req,
    );
    const s2: Record<string, number> = {};
    const d2 = diskStore();
    await lfsFetchFrom(
      [
        { name: "B", url: URL_, fetch: B },
        { name: "C", url: URL_, fetch: failing },
      ],
      d2,
      [p],
      { chunkSize: 1 << 20, stats: s2 },
    );
    expect((s2.B ?? 0) + (s2.C ?? 0)).toBe(p.size);
    expect(sha(await collect(d2.read(p.oid)))).toBe(p.oid);
  }, 120_000);
});

describe("R6 mandatory verify; bad peers", () => {
  it("a source serving altered bytes is found and reported; the object comes from the good one", async () => {
    const content = noise(4 << 20, 10);
    const p = { oid: sha(content), size: content.length };
    const { B, C } = await twoHolders(content);
    const lying = onTransfers(C, async (req) => {
      const res = await C(req);
      const bytes = new Uint8Array(await res.arrayBuffer());
      bytes[0] = (bytes[0] as number) ^ 0xff;
      return new Response(bytes, { status: res.status, headers: res.headers });
    });
    const dest = diskStore();
    const r = await lfsFetchFrom(
      [
        { name: "B", url: URL_, fetch: B },
        { name: "C", url: URL_, fetch: lying },
      ],
      dest,
      [p],
      { chunkSize: 1 << 20 },
    );
    expect(r).toEqual({ downloaded: [p.oid], bad: ["C"] });
    expect(sha(await collect(dest.read(p.oid)))).toBe(p.oid);
    // every source lying: refused, nothing visible
    const d2 = diskStore();
    await expect(
      lfsFetchFrom([{ name: "C", url: URL_, fetch: lying }], d2, [p], { chunkSize: 1 << 20 }),
    ).rejects.toThrow();
    expect(await d2.has(p.oid)).toBe(false);
  }, 120_000);
});

describe("R7 bounded memory over the bridge", () => {
  it("64 MiB from two sources over pairedLinks in 4 MiB chunks: live memory < 32 MiB", async () => {
    const size = 64 << 20;
    const chunk = noise(1 << 20, 11);
    const source = async function* () {
      for (let i = 0; i < size >> 20; i++) {
        const c = chunk.slice();
        c[0] = i & 255;
        yield c;
      }
    };
    const m = await mesh();
    let p = { oid: "", size: 0 };
    for (const name of ["B", "C"]) {
      const s = diskStore();
      p = await s.put(source());
      m.serving.set(name, meshLfsHandler(s, { issuer: m.signer.mesh, rules: gitRules() }));
    }
    const B = await m.client("D", "B", ["member"]);
    const C = await m.client("D", "C", ["member"]);
    const gc = (globalThis as { gc?: () => void }).gc;
    const used = () => {
      const u = process.memoryUsage();
      return u.heapUsed + u.arrayBuffers;
    };
    gc?.();
    const base = used();
    let peak = base;
    const timer = setInterval(() => {
      gc?.();
      peak = Math.max(peak, used());
    }, 50);
    const dest = diskStore();
    try {
      await lfsFetchFrom(
        [
          { name: "B", url: URL_, fetch: B },
          { name: "C", url: URL_, fetch: C },
        ],
        dest,
        [p],
        { chunkSize: 4 << 20 },
      );
    } finally {
      clearInterval(timer);
    }
    console.log(`R7 live growth ${((peak - base) / (1 << 20)).toFixed(1)} MiB`);
    expect(await dest.size(p.oid)).toBe(size);
    expect((peak - base) / (1 << 20)).toBeLessThan(32);
  }, 300_000);
});
