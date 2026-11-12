import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteOverLink, serveFetchOverLink } from "@statewalker/httpeers-bridge";
import { pairedLinks } from "@statewalker/httpeers-bridge/ports";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import { rng } from "../../29-merge/tests/tree-harness.js";
import {
  commitFolder,
  type Endpoint,
  folderFiles,
  headOf,
  openEndpoint,
} from "../../38-workspace-sync/src/workspace.js";
import { idle, type Peer, serveEndpoint, syncWith, watchEndpoint } from "../src/net-sync.js";

const dirs: string[] = [];
const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const enc = new TextEncoder();
let clock = 1_700_000_000;
const now = () => clock++;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function endpoint(name: string): Promise<Endpoint> {
  return openEndpoint({ name, folder: new MemFilesApi(), storage: new MemFilesApi(), now });
}
const put = (ep: Endpoint, path: string, text: string) =>
  ep.folder.write(`/${path}`, [enc.encode(text)]);
/** incompressible text, so a pack of it is as large as it looks */
const noise = (n: number, seed: number) => {
  const rand = rng(seed);
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(97 + Math.floor(rand() * 26));
  return `${out}\n`;
};

/** `client` reaching `server` only through httpeers' bridge, as a `Peer` for `syncWith`. */
async function connect(
  client: Endpoint,
  server: Endpoint,
  wrap: (f: typeof fetch) => typeof fetch = (f) => f,
): Promise<Peer> {
  const [mine, theirs] = pairedLinks(client.name, server.name);
  stops.push(await serveFetchOverLink({ link: theirs, dispatch: serveEndpoint(server) }));
  const remote = createRemoteOverLink({ link: mine });
  const f = ((input: RequestInfo | URL, init?: RequestInit) =>
    remote(
      server.name,
      new Request(input, { ...init, duplex: "half" } as RequestInit),
    )) as typeof fetch;
  return { name: server.name, url: `http://${server.name}.peer/repo.git`, fetch: wrap(f) };
}

async function same(eps: Endpoint[]) {
  await Promise.all(eps.map(idle));
  const heads = await Promise.all(eps.map(headOf));
  const files = await Promise.all(eps.map(folderFiles));
  for (let i = 1; i < eps.length; i++) {
    expect(heads[i], `${eps[i]?.name} head`).toBe(heads[0]);
    expect(files[i], `${eps[i]?.name} files`).toEqual(files[0]);
  }
  return files[0] as Record<string, string>;
}

function fsck(ep: Endpoint) {
  return (async () => {
    const d = mkdtempSync(join(tmpdir(), "x17b-"));
    dirs.push(d);
    for await (const e of ep.storage.list("/", { recursive: true })) {
      if (e.kind !== "file") continue;
      const parts: Uint8Array[] = [];
      for await (const p of ep.storage.read(e.path)) parts.push(p);
      mkdirSync(dirname(join(d, ".git", e.path)), { recursive: true });
      writeFileSync(join(d, ".git", e.path), Buffer.concat(parts));
    }
    execFileSync("git", ["fsck", "--strict", "--no-dangling"], { cwd: d, env: gitEnv });
  })();
}

describe("N1 two endpoints sync only over the transport", () => {
  it("different and same files: one commit, the same files, the remote's folder checked out", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    const toB = await connect(a, b);
    await put(a, "shared.txt", "one\ntwo\nthree\n");
    await syncWith(a, toB);
    expect(await same([a, b])).toEqual({ "shared.txt": "one\ntwo\nthree\n" });
    await put(a, "a.txt", "from a\n");
    await put(b, "b/b.txt", "from b\n");
    await put(a, "shared.txt", "ONE\ntwo\nthree\n");
    await put(b, "shared.txt", "one\ntwo\nTHREE\n");
    await commitFolder(b);
    const r = await syncWith(a, toB);
    expect(r.conflicts).toEqual([]);
    expect(await same([a, b])).toEqual({
      "a.txt": "from a\n",
      "b/b.txt": "from b\n",
      "shared.txt": "ONE\ntwo\nTHREE\n",
    });
    await fsck(a);
    await fsck(b);
  });
});

describe("N2 a push that loses a race is refused and retried", () => {
  it("the remote commits between our fetch and our push: nothing of it is lost", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    const toB = await connect(a, b);
    await put(a, "base.txt", "base\n");
    await syncWith(a, toB);
    await put(a, "a.txt", "a\n");
    let raced = false;
    const r = await syncWith(a, toB, {
      beforePush: async () => {
        if (raced) return;
        raced = true;
        await put(b, "late.txt", "committed while a was merging\n");
        await commitFolder(b);
      },
    });
    expect(r.attempts).toBeGreaterThanOrEqual(2);
    const files = await same([a, b]);
    expect(files["late.txt"]).toBe("committed while a was merging\n");
    expect(files["a.txt"]).toBe("a\n");
  });
});

describe("N2b (review of the mutants) an incoming push meets an uncommitted edit on the same path", () => {
  it("the remote's folder edit and the pushed change both survive (merged, or conflict-marked)", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    const toB = await connect(a, b);
    await put(a, "p.txt", "base\n");
    await syncWith(a, toB);
    await idle(b);
    await put(b, "p.txt", "typed on b, not committed\n"); // b's own sync has not run
    await put(a, "p.txt", "pushed from a\n");
    await syncWith(a, toB); // the push lands; b's refresh checks out over its uncommitted edit
    await idle(b);
    const onB = (await folderFiles(b))["p.txt"] as string;
    expect(onB).toContain("typed on b");
    expect(onB).toContain("pushed from a");
    await syncWith(a, toB);
    expect((await same([a, b]))["p.txt"]).toBe(onB);
  });
});

describe("N7 (review of #114) a push that lands on an endpoint during its own sync", () => {
  it("is checked out, not reverted: the pushed edits and deletions survive", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    const c = await endpoint("c");
    const cToA = await connect(c, a);
    await put(c, "p.txt", "base\n");
    await put(c, "gone.txt", "to delete\n");
    await syncWith(c, cToA);
    await idle(a);
    await put(c, "p.txt", "from c\n");
    await c.folder.remove("/gone.txt");
    await put(a, "a.txt", "a's own\n");
    await put(b, "b.txt", "b's\n"); // b has history of its own, so a's sync merges
    await commitFolder(b);
    let pushed = false;
    // while a fetches from b, c pushes to a
    const duringFetch = (f: typeof fetch): typeof fetch =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, { ...init, duplex: "half" } as RequestInit);
        if (!pushed && req.method === "POST" && req.url.endsWith("/git-upload-pack")) {
          pushed = true;
          await syncWith(c, cToA);
        }
        return f(req);
      }) as typeof fetch;
    await syncWith(a, await connect(a, b, duringFetch));
    expect(pushed).toBe(true);
    await idle(a);
    await commitFolder(a);
    const files = await folderFiles(a);
    expect(files["p.txt"]).toBe("from c\n");
    expect(files["gone.txt"]).toBeUndefined();
    expect(files["a.txt"]).toBe("a's own\n");
    await syncWith(c, cToA);
    expect((await same([a, c]))["p.txt"]).toBe("from c\n");
  });

  it("a push moving main between the merge's read and its compare-and-swap is retried, not thrown", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    const c = await endpoint("c");
    const toB = await connect(a, b);
    const cToA = await connect(c, a);
    await put(b, "b.txt", "b\n");
    await commitFolder(b);
    await put(c, "c.txt", "c\n");
    const batch = a.repo.refs.batch.bind(a.repo.refs);
    let raced = false;
    a.repo.refs.batch = async (cmds) => {
      if (!raced && cmds.some((x) => x.name === "refs/heads/main" && x.new !== null)) {
        raced = true;
        await syncWith(c, cToA); // moves a's main first
      }
      return batch(cmds);
    };
    const r = await syncWith(a, toB);
    expect(raced).toBe(true);
    expect(r.attempts).toBeGreaterThanOrEqual(2);
    await syncWith(c, cToA);
    const files = await same([a, b, c].slice(0, 2));
    expect(files).toMatchObject({ "b.txt": "b\n", "c.txt": "c\n" });
  });
});

describe("N3 property test: a hub and two spokes, only over the transport", () => {
  it("50 random schedules converge, and every untouched edit survives", async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rand = rng(seed);
      const hub = await endpoint("hub");
      const s1 = await endpoint("s1");
      const s2 = await endpoint("s2");
      const peers = new Map([
        [s1, await connect(s1, hub)],
        [s2, await connect(s2, hub)],
      ]);
      const eps = [hub, s1, s2];
      const last = new Map<string, string>(); // path → last content its owner wrote
      for (let step = 0; step < 14; step++) {
        const ep = eps[Math.floor(rand() * 3)] as Endpoint;
        const r = rand();
        if (r < 0.55) {
          const path = `${ep.name}/f${Math.floor(rand() * 3)}.txt`;
          const text = `${ep.name} ${seed} ${step}\n`;
          await put(ep, path, text);
          last.set(path, text);
        } else if (r < 0.65) {
          await put(ep, "shared.txt", `${ep.name} ${step}\n`); // conflicts allowed
        } else if (ep !== hub) {
          await syncWith(ep, peers.get(ep) as Peer);
        }
      }
      // the hub's own edits are committed by its own sync or watcher, which this hub does not run
      await idle(hub);
      await commitFolder(hub);
      for (let round = 0; round < 2; round++)
        for (const s of [s1, s2]) await syncWith(s, peers.get(s) as Peer);
      const files = await same(eps);
      for (const [path, text] of last) expect(files[path], `seed ${seed} ${path}`).toBe(text);
      for (const s of stops.splice(0).reverse()) await s();
    }
  }, 120_000);
});

/** Fails a request after `bytes` of the given body have passed: the response (fetch) or the request (push). */
function failing(phase: "fetch" | "push", bytes: number) {
  return (f: typeof fetch): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, { ...init, duplex: "half" } as RequestInit);
      const cut = (body: ReadableStream<Uint8Array>) => {
        let seen = 0;
        return body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, c) {
              seen += chunk.byteLength;
              if (seen > bytes) c.error(new Error(`link failed after ${bytes} bytes`));
              else c.enqueue(chunk);
            },
          }),
        );
      };
      const isPush = req.method === "POST" && req.url.endsWith("/git-receive-pack");
      if (phase === "push" && isPush && req.body) {
        return f(new Request(req, { body: cut(req.body), duplex: "half" } as RequestInit));
      }
      const res = await f(req);
      if (
        phase === "fetch" &&
        req.method === "POST" &&
        req.url.endsWith("/git-upload-pack") &&
        res.body
      )
        return new Response(cut(res.body), { status: res.status, headers: res.headers });
      return res;
    }) as typeof fetch;
}

describe("N4 a link that fails halfway leaves both repositories valid, and the next sync converges", () => {
  for (const phase of ["fetch", "push"] as const) {
    it(`fails during the ${phase}`, async () => {
      const a = await endpoint("a");
      const b = await endpoint("b");
      for (let i = 0; i < 30; i++) await put(b, `b/${i}.txt`, noise(2000, 100 + i));
      for (let i = 0; i < 30; i++) await put(a, `a/${i}.txt`, noise(2000, 200 + i));
      await commitFolder(b);
      if (phase === "push") {
        // b's history reaches a first, so the failing step is a's push
        await syncWith(a, await connect(a, b));
        for (let i = 0; i < 30; i++) await put(a, `a2/${i}.txt`, noise(2000, 300 + i));
      }
      const bad = await connect(a, b, failing(phase, 4096));
      await expect(syncWith(a, bad)).rejects.toThrow();
      await idle(a);
      await idle(b);
      await fsck(a);
      await fsck(b);
      await syncWith(a, await connect(a, b));
      const files = await same([a, b]);
      expect(Object.keys(files).length).toBe(phase === "push" ? 90 : 60);
    });
  }
});

describe("N5 a watcher keeps endpoints in step", () => {
  it("an edit on A reaches B's folder with no sync call; a burst is debounced; stop() ends it", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    let syncs = 0;
    const watcher = watchEndpoint(a, [await connect(a, b)], {
      pollMs: 20,
      debounceMs: 150,
      onSync: () => {
        syncs++;
      },
    });
    stops.push(() => watcher.stop());
    await put(a, "hello.txt", "hi\n");
    await expect
      .poll(async () => (await folderFiles(b))["hello.txt"], { timeout: 5000 })
      .toBe("hi\n");
    await watcher.idle();
    syncs = 0;
    for (let i = 0; i < 20; i++) {
      await put(a, "burst.txt", `write ${i}\n`);
      await sleep(5);
    }
    await expect
      .poll(async () => (await folderFiles(b))["burst.txt"], { timeout: 5000 })
      .toBe("write 19\n");
    await watcher.idle();
    expect(syncs).toBeLessThanOrEqual(3);
    await watcher.stop();
    await put(a, "after-stop.txt", "x\n");
    await sleep(500);
    expect((await folderFiles(b))["after-stop.txt"]).toBeUndefined();
  });

  it("a change made during a round is synced after it", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    let started!: () => void;
    const roundStarted = new Promise<void>((r) => {
      started = r;
    });
    let first = true;
    const slow = (f: typeof fetch): typeof fetch =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (first) {
          first = false;
          started();
          await sleep(300);
        }
        return f(input, init);
      }) as typeof fetch;
    const watcher = watchEndpoint(a, [await connect(a, b, slow)], { pollMs: 20, debounceMs: 50 });
    stops.push(() => watcher.stop());
    await put(a, "one.txt", "1\n");
    await roundStarted;
    await put(a, "during.txt", "written while the round ran\n");
    await expect
      .poll(async () => (await folderFiles(b))["during.txt"], { timeout: 5000 })
      .toBe("written while the round ran\n");
  });

  it("stop() during a round: the round finishes and nothing runs after it", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    let started!: () => void;
    const roundStarted = new Promise<void>((r) => {
      started = r;
    });
    let first = true;
    const slow = (f: typeof fetch): typeof fetch =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (first) {
          // only the round in progress is slow: a round after stop() would finish well in time
          first = false;
          started();
          await sleep(300);
        }
        return f(input, init);
      }) as typeof fetch;
    const watcher = watchEndpoint(a, [await connect(a, b, slow)], { pollMs: 20, debounceMs: 50 });
    stops.push(() => watcher.stop());
    await put(a, "one.txt", "1\n");
    await roundStarted;
    const stopping = watcher.stop(); // mid-round
    await put(a, "two.txt", "2\n");
    await stopping;
    await sleep(1000);
    expect((await folderFiles(b))["two.txt"]).toBeUndefined();
  });

  it("watchers on both sides: edits made on each side converge", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    const wa = watchEndpoint(a, [await connect(a, b)], {
      pollMs: 20,
      debounceMs: 60,
      syncEveryMs: 200,
    });
    const wb = watchEndpoint(b, [await connect(b, a)], {
      pollMs: 20,
      debounceMs: 60,
      syncEveryMs: 200,
    });
    stops.push(
      () => wa.stop(),
      () => wb.stop(),
    );
    await put(a, "from-a.txt", "a\n");
    await put(b, "from-b.txt", "b\n");
    const want = { "from-a.txt": "a\n", "from-b.txt": "b\n" };
    await expect.poll(async () => folderFiles(a), { timeout: 8000 }).toEqual(want);
    await expect.poll(async () => folderFiles(b), { timeout: 8000 }).toEqual(want);
    await wa.stop();
    await wb.stop();
    await same([a, b]);
  });
});

describe("N6 portable", () => {
  it("src/ has no node: imports", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    for (const f of readdirSync(src))
      expect(readFileSync(join(src, f), "utf8"), f).not.toMatch(/from "node:/);
  });
});
