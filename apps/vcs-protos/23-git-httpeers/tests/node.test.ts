import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigner, mintToken } from "@statewalker/httpeers-access/issuer";
import { createRemoteOverLink, serveFetchOverLink } from "@statewalker/httpeers-bridge";
import { pairedLinks } from "@statewalker/httpeers-bridge/ports";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, noise, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { log } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import { clone, fetchFrom } from "../../21-smart-http/src/client.js";
import { DELIM, FLUSH, PktReader, pkt } from "../../21-smart-http/src/pkt-line.js";
import { push } from "../../22-receive-pack/src/client.js";
import { gitRules, meshFetch, meshGitHandler } from "../src/mesh-git.js";

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const s of stops) await s().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x8c-"));
  dirs.push(d);
  return d;
};
const open = (dir: string) =>
  filesRepository(new StreamingNodeFilesApi(join(dir, ".git")), nodeRefFiles(join(dir, ".git")));
const openBare = (dir: string) =>
  filesRepository(new StreamingNodeFilesApi(dir), nodeRefFiles(dir));
const emptyRepo = () => {
  const d = tmp();
  git(d, ["init", "-q", "-b", "main", "."]);
  return d;
};
const rev = (d: string, r: string) => git(d, ["rev-parse", r]).toString().trim();
const commitFile = (d: string, file: string, content: string, msg: string) => {
  writeFileSync(join(d, file), content);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", msg]);
};
const URL_ = "http://peer.local/repo.git";

/** A serving peer "B" with `repo`, and a way to connect callers to it. */
async function mesh(
  repo: Repository,
  opts: { requestTimeoutMs?: number; contributors?: boolean } = {},
) {
  const signer = await generateSigner();
  const handler = meshGitHandler(repo, {
    issuer: signer.mesh,
    rules: gitRules({ contributors: opts.contributors ?? false }),
  });
  const connect = async (peer: string) => {
    const [mine, theirs] = pairedLinks(peer, "B");
    stops.push(await serveFetchOverLink({ link: theirs, dispatch: handler }));
    return createRemoteOverLink({ link: mine, requestTimeoutMs: opts.requestTimeoutMs });
  };
  const token = (peer: string, roles: string[], ttlMs = 60_000) =>
    mintToken({ signer, sub: peer, roles, ttlMs });
  /** a fetch for `peer` holding `roles` */
  const client = async (peer: string, roles: string[]) =>
    meshFetch(await connect(peer), "B", await token(peer, roles));
  return { signer, connect, token, client };
}

/** A bare serving repository with `src`'s history. */
function servingCopy(src: string) {
  const d = join(tmp(), "served.git");
  git(tmpdir(), ["clone", "-q", "--bare", src, d]);
  return d;
}

describe("R1 clone, fetch and push over the mesh", () => {
  it("logs equal; the serving repository passes fsck --strict", async () => {
    const src = repoWithHistory(10);
    const served = servingCopy(src);
    const server = await openBare(served);
    const m = await mesh(server);
    const f = await m.client("A", ["admin"]);
    const d = emptyRepo();
    const repo = await open(d);
    await clone(URL_, repo, { fetch: f });
    expect(await log(repo, "HEAD")).toEqual(await log(server, "HEAD"));
    // new commits upstream, then fetch
    const up = join(tmp(), "up");
    git(tmpdir(), ["clone", "-q", served, up]);
    commitFile(up, "file0.txt", "upstream\n", "upstream");
    git(up, ["push", "-q", "origin", "main"]);
    await fetchFrom(URL_, repo, { fetch: f, refspecs: ["+refs/heads/*:refs/heads/*"] });
    expect(rev(d, "refs/heads/main")).toBe(rev(served, "refs/heads/main"));
    // push a branch back
    git(d, ["checkout", "-q", "main"]);
    git(d, ["reset", "-q", "--hard", "main"]);
    commitFile(d, "file1.txt", "from A\n", "from A");
    const r = await push(URL_, repo, { fetch: f, refspecs: ["HEAD:refs/heads/from-a"] });
    expect(r).toEqual([{ ref: "refs/heads/from-a", ok: true }]);
    expect(rev(served, "refs/heads/from-a")).toBe(rev(d, "HEAD"));
    git(served, ["fsck", "--strict"]);
  }, 120_000);
});

describe("R2 roles", () => {
  it("httpeers' mesh roles: no token 401; member reads only; with contributors, members write refs/peers/<self>/*; admin anywhere", async () => {
    const src = repoWithHistory(5);
    const served = servingCopy(src);
    const server = await openBare(served);
    const m = await mesh(server);
    const mc = await mesh(server, { contributors: true });
    // no token
    const anon = await m.connect("anon");
    const res = await anon(
      "B",
      new Request(`${URL_}/info/refs?service=git-upload-pack`, {
        headers: { "git-protocol": "version=2" },
      }),
    );
    expect(res.status).toBe(401);
    // reader
    const reader = await m.client("R", ["member"]);
    const d = emptyRepo();
    const repo = await open(d);
    await clone(URL_, repo, { fetch: reader });
    commitFile(d, "file0.txt", "r\n", "r");
    await expect(
      push(URL_, repo, { fetch: reader, refspecs: ["HEAD:refs/peers/R/x"] }),
    ).rejects.toThrow(/403/);
    // member, contributors on: its own namespace only
    const member = await mc.client("M", ["member"]);
    let r = await push(URL_, repo, { fetch: member, refspecs: ["HEAD:refs/heads/main"] });
    expect(r[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/not allowed/) });
    r = await push(URL_, repo, { fetch: member, refspecs: ["HEAD:refs/peers/X/main"] });
    expect(r[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/not allowed/) });
    r = await push(URL_, repo, { fetch: member, refspecs: ["HEAD:refs/peers/M/main"] });
    expect(r[0]?.ok).toBe(true);
    // admin
    const maint = await m.client("T", ["admin"]);
    r = await push(URL_, repo, { fetch: maint, refspecs: ["HEAD:refs/heads/main"] });
    expect(r[0]?.ok).toBe(true);
    expect(rev(served, "refs/heads/main")).toBe(rev(d, "HEAD"));
  }, 120_000);
});

describe("R3 a push longer than the bridge's request timeout", () => {
  it("succeeds: the response head comes before the upload ends", async () => {
    const src = repoWithHistory(3);
    const served = servingCopy(src);
    const server = await openBare(served);
    const m = await mesh(server, { requestTimeoutMs: 1500 });
    const base = await m.client("A", ["admin"]);
    // a fetch whose request bodies trickle: 3 s for the upload
    const slow: typeof fetch = async (input, init) => {
      if (!init?.body || typeof (init.body as ReadableStream).getReader !== "function")
        return base(input, init);
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      const start = Date.now();
      let sentLast = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          const r = await reader.read();
          if (r.done) {
            const wait = 3000 - (Date.now() - start);
            if (wait > 0 && !sentLast) await new Promise((x) => setTimeout(x, wait));
            sentLast = true;
            ctrl.close();
            return;
          }
          await new Promise((x) => setTimeout(x, 200));
          ctrl.enqueue(r.value);
        },
      });
      return base(input, { ...init, body, duplex: "half" } as RequestInit);
    };
    const d = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", served, d]);
    commitFile(d, "file0.txt", "slow\n", "slow");
    const t0 = Date.now();
    const r = await push(URL_, await open(d), { fetch: slow, refspecs: ["HEAD:refs/heads/slow"] });
    expect(Date.now() - t0).toBeGreaterThan(3000);
    expect(r[0]?.ok).toBe(true);
    expect(rev(served, "refs/heads/slow")).toBe(rev(d, "HEAD"));
  }, 60_000);
});

describe("R4 first byte before the pack is generated", () => {
  it("progress arrives before half of the objects are read", async () => {
    const d = emptyRepo();
    for (let i = 0; i < 48; i++) writeFileSync(join(d, `b${i}.bin`), noise(256 * 1024, i + 1));
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "blobs"]);
    const server = await open(d);
    let reads = 0;
    const get = server.objects.get.bind(server.objects);
    server.objects.get = async (oid, o) => {
      reads++;
      return get(oid, o);
    };
    const m = await mesh(server);
    const f = await m.client("A", ["member"]);
    const body = new Blob([
      pkt("command=fetch\n"),
      DELIM,
      pkt(`want ${rev(d, "HEAD")}\n`),
      pkt("done\n"),
      FLUSH,
    ] as BlobPart[]);
    reads = 0;
    const res = await f(`${URL_}/git-upload-pack`, {
      method: "POST",
      headers: {
        "git-protocol": "version=2",
        "content-type": "application/x-git-upload-pack-request",
      },
      body,
    });
    const r = new PktReader(res.body as unknown as AsyncIterable<Uint8Array>);
    let first = -1;
    let inPack = false;
    for (;;) {
      const p = await r.read();
      if (!p) break;
      if (p.kind !== "data") continue;
      if (!inPack) {
        inPack = new TextDecoder().decode(p.data) === "packfile\n";
        continue;
      }
      if (first < 0) first = reads;
    }
    console.log(`R4: first byte after ${first} of ${reads} reads`);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(reads / 2);
  }, 120_000);
});

describe("R5 hostile tokens", () => {
  it("expired and foreign → 401, tampered → 403 (signature); an unknown role grants nothing", async () => {
    const src = repoWithHistory(3);
    const server = await openBare(servingCopy(src));
    const m = await mesh(server);
    const conn = await m.connect("A");
    const ask = (token: string) =>
      conn(
        "B",
        new Request(`${URL_}/info/refs?service=git-upload-pack`, {
          headers: { "git-protocol": "version=2", "x-httpeers-token": token },
        }),
      );
    const expired = await m.token("A", ["admin"], 1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await ask(expired)).status).toBe(401);
    expect((await ask(await m.token("Z", ["admin"]))).status).toBe(401);
    const good = await m.token("A", ["admin"]);
    const tampered = `${good.slice(0, -4)}${good.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    // httpeers' refusal table: a bad signature is 403 ("a fresh token will not help"); expired and
    // foreign-peer tokens are 401 (a refresh may) — refused either way, the reason in the body
    const t = await ask(tampered);
    expect(t.status).toBe(403);
    expect(await t.text()).toMatch(/signature/);
    expect((await ask(await m.token("A", ["stranger"]))).status).toBe(403);
    expect((await ask(good)).status).toBe(200);
  }, 60_000);
});

describe("R6 per-peer namespaces", () => {
  it("two members push to their own namespaces and read each other's, never overwrite", async () => {
    const src = repoWithHistory(4);
    const served = servingCopy(src);
    const server = await openBare(served);
    const m = await mesh(server, { contributors: true });
    const fa = await m.client("A", ["member"]);
    const fc = await m.client("C", ["member"]);
    const da = join(tmp(), "a");
    const dc = join(tmp(), "c");
    git(tmpdir(), ["clone", "-q", served, da]);
    git(tmpdir(), ["clone", "-q", served, dc]);
    commitFile(da, "file0.txt", "a\n", "a");
    commitFile(dc, "file1.txt", "c\n", "c");
    const ra = await open(da);
    const rc = await open(dc);
    expect((await push(URL_, ra, { fetch: fa, refspecs: ["HEAD:refs/peers/A/main"] }))[0]?.ok).toBe(
      true,
    );
    expect((await push(URL_, rc, { fetch: fc, refspecs: ["HEAD:refs/peers/C/main"] }))[0]?.ok).toBe(
      true,
    );
    await fetchFrom(URL_, ra, { fetch: fa, refspecs: ["+refs/peers/*:refs/remotes/peers/*"] });
    expect(rev(da, "refs/remotes/peers/C/main")).toBe(rev(dc, "HEAD"));
    const r = await push(URL_, ra, { fetch: fa, refspecs: ["+HEAD:refs/peers/C/main"] });
    expect(r[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/not allowed/) });
    expect(rev(served, "refs/peers/C/main")).toBe(rev(dc, "HEAD"));
    const r2 = await push(URL_, rc, { fetch: fc, refspecs: ["+HEAD:refs/peers/A/main"] });
    expect(r2[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/not allowed/) });
    expect(rev(served, "refs/peers/A/main")).toBe(rev(da, "HEAD"));
  }, 120_000);
});

describe("review cases (#84)", () => {
  it("roles as a standard hub issues them: admin writes, member reads, hidden reads; own-namespace pushes are opt-in", async () => {
    const src = repoWithHistory(3);
    const server = await openBare(servingCopy(src));
    const m = await mesh(server);
    const conn = await m.connect("P");
    const status = async (roles: string[], service: string) =>
      (
        await conn(
          "B",
          new Request(`${URL_}/info/refs?service=${service}`, {
            headers: { "git-protocol": "version=2", "x-httpeers-token": await m.token("P", roles) },
          }),
        )
      ).status;
    expect(await status(["admin"], "git-upload-pack")).toBe(200);
    expect(await status(["admin"], "git-receive-pack")).toBe(200);
    expect(await status(["member"], "git-upload-pack")).toBe(200);
    expect(await status(["member"], "git-receive-pack")).toBe(403);
    expect(await status(["hidden"], "git-upload-pack")).toBe(200);
    expect(await status(["hidden"], "git-receive-pack")).toBe(403);
  }, 60_000);
  it("a push refused for every ref stores nothing (its pack is not read)", async () => {
    const src = repoWithHistory(3);
    const served = servingCopy(src);
    const server = await openBare(served);
    const m = await mesh(server, { contributors: true });
    const f = await m.client("M", ["member"]);
    const d = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", served, d]);
    commitFile(d, "junk.bin", Buffer.from(noise(100_000, 3)).toString("base64"), "junk");
    const tip = rev(d, "HEAD");
    const r = await push(URL_, await open(d), { fetch: f, refspecs: ["HEAD:refs/heads/main"] });
    expect(r[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/not allowed/) });
    expect(() => git(served, ["cat-file", "-t", tip])).toThrow();
  }, 60_000);
  it("an error after the response head reaches the client as a report, not a dropped connection", async () => {
    const src = repoWithHistory(3);
    const served = servingCopy(src);
    const server = await openBare(served);
    const read = server.refs.read.bind(server.refs);
    let explode = false;
    server.refs.read = async (name) => {
      if (explode && name === "HEAD") throw new Error("disk exploded");
      return read(name);
    };
    const m = await mesh(server);
    const f = await m.client("A", ["admin"]);
    const d = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", served, d]);
    commitFile(d, "file0.txt", "x\n", "x");
    explode = true;
    const err = await push(URL_, await open(d), {
      fetch: f,
      refspecs: ["HEAD:refs/heads/x"],
    }).catch((e) => e);
    expect(String(err)).toMatch(/internal error.*disk exploded|disk exploded/);
  }, 60_000);
  it("a proven peer id that cannot name a namespace (a '/' in it) is refused own-namespace writes", async () => {
    const src = repoWithHistory(3);
    const served = servingCopy(src);
    const server = await openBare(served);
    const m = await mesh(server, { contributors: true });
    const f = await m.client("A/B", ["member"]);
    const d = join(tmp(), "w");
    git(tmpdir(), ["clone", "-q", served, d]);
    commitFile(d, "file0.txt", "x\n", "x");
    await expect(
      push(URL_, await open(d), { fetch: f, refspecs: ["HEAD:refs/peers/A/B/main"] }),
    ).rejects.toThrow(/403/);
  }, 60_000);
  it("hostile git input over the mesh: malformed requests are refused, the peer keeps serving", async () => {
    const src = repoWithHistory(3);
    const server = await openBare(servingCopy(src));
    const m = await mesh(server);
    const f = await m.client("A", ["admin"]);
    const bad = await f(`${URL_}/git-upload-pack`, {
      method: "POST",
      headers: { "git-protocol": "version=2" },
      body: new TextEncoder().encode("00zzgarbage"),
    });
    expect(new TextDecoder().decode(new Uint8Array(await bad.arrayBuffer()))).toMatch(/ERR/);
    const badPush = await f(`${URL_}/git-receive-pack`, {
      method: "POST",
      body: new Blob([pkt("not a command\n"), FLUSH] as BlobPart[]),
    });
    expect(badPush.status).toBe(400);
    const d = emptyRepo();
    await clone(URL_, await open(d), { fetch: f });
    expect(rev(d, "HEAD")).toBe(rev(src, "HEAD"));
  }, 60_000);
});
