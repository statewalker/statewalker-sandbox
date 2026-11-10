import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha1 } from "@noble/hashes/legacy.js";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { buildPack, type CraftEntry, delta, oidOf } from "../../12-index-pack/src/craft.js";
import { git, noise, packAll, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { openObjectDatabase } from "../../13-pack-reader/src/object-db.js";
import {
  type ExternalBase,
  installPack as installX6b1,
} from "../../14-thin-packs/src/index-pack.js";
import { PackError, startIndexJob, stepIndexJob } from "../src/index-job.js";
import { exportSha1, importSha1 } from "../src/sha1-state.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x6b2-"));
  dirs.push(d);
  return d;
};
async function* chunks(bytes: Uint8Array, size = 65536) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const collect = async (s: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
};
const listNames = async (files: FilesApi, dir: string) => {
  const out: string[] = [];
  for await (const e of files.list(dir)) out.push(e.name);
  return out.sort();
};

/** The reference: X6b1's one-shot install into a fresh store; pack bytes and idx. */
async function reference(pack: Uint8Array, externalBase?: ExternalBase) {
  const files = new MemFilesApi();
  const r = await installX6b1(files, "/p", chunks(pack), { externalBase });
  return {
    packId: r.packId,
    idx: r.idx,
    pack: await collect(files.read(`/p/pack-${r.packId}.pack`)),
  };
}

/** Runs a job in steps of `units`, every step cold; returns the result and the step reports. */
async function runJob(
  files: FilesApi,
  pack: Uint8Array,
  units: number,
  opts: { externalBase?: ExternalBase; cold?: boolean; budgetMs?: number } = {},
) {
  const id = await startIndexJob(files, "/p", chunks(pack));
  const steps: Awaited<ReturnType<typeof stepIndexJob>>[] = [];
  for (;;) {
    const r = await stepIndexJob(files, "/p", id, {
      units,
      budgetMs: opts.budgetMs,
      externalBase: opts.externalBase,
      cold: opts.cold ?? true,
    });
    steps.push(r);
    if (r.done) return { result: r.result, steps, id };
    if (steps.length > 1e6) throw new Error("no progress");
  }
}

/** A sender and a receiver holding `have`; the thin pack carries `want ^have` (as in X6b1). */
function thinCase(sender: string, want: string, have: string) {
  const receiver = tmp();
  git(receiver, ["init", "-q", "-b", "main", "."]);
  const haveObjects = git(sender, ["rev-list", "--objects", have]);
  git(
    receiver,
    ["index-pack", "--stdin"],
    git(sender, ["pack-objects", "--stdout", "-q"], haveObjects),
  );
  const thin = new Uint8Array(
    git(
      sender,
      ["pack-objects", "--revs", "--thin", "--delta-base-offset", "--stdout", "-q"],
      `${want}\n^${have}\n`,
    ),
  );
  return { receiver, thin };
}
async function odbBase(receiver: string): Promise<ExternalBase> {
  const db = await openObjectDatabase(
    new StreamingNodeFilesApi(join(receiver, ".git")),
    "/objects",
  );
  return async (oid) => {
    const o = await db.get(oid);
    return o ? { type: o.type, data: await collect(o.content) } : undefined;
  };
}
/** A comb: a REF chain of `depth` with an OFS leaf on every node (X6b1's review shape). */
function comb(depth: number): Uint8Array {
  const enc = new TextEncoder();
  const prefix = "x".repeat(50);
  const content = (t: string) => enc.encode(prefix + t.padStart(10, "0"));
  const d = (tag: string) => {
    const t = enc.encode(tag.padStart(10, "0"));
    return delta(60, 60, [0x90, 50, t.length, ...t]);
  };
  const e: CraftEntry[] = [{ kind: 3, data: content("c0") }];
  let prev = content("c0");
  for (let i = 1; i <= depth; i++) {
    e.push({ kind: 7, baseOid: oidOf("blob", prev), data: d(`c${i}`) });
    e.push({ kind: 6, baseIdx: e.length - 1, data: d(`l${i}`) });
    prev = content(`c${i}`);
  }
  return buildPack(e);
}

const history = repoWithHistory(30);
const aggressive = (() => {
  const r = repoWithHistory(30);
  git(r, ["gc", "-q", "--aggressive"]);
  const p = readdirSync(join(r, ".git", "objects", "pack")).find((n) =>
    n.endsWith(".pack"),
  ) as string;
  return new Uint8Array(readFileSync(join(r, ".git", "objects", "pack", p)));
})();
const withBig = repoWithHistory(3, { bigBlobBytes: 4 * 2 ** 20 });
const packs: [string, Uint8Array, number[]][] = [
  ["OFS_DELTA", packAll(history, true), [1, 7, 1000]],
  ["REF_DELTA", packAll(history, false), [1, 7, 1000]],
  ["gc --aggressive", aggressive, [7, 1000]],
  ["a 4 MiB blob and a delta against it", packAll(withBig, true), [1, 7, 1000]],
  ["a 300-deep comb", comb(300), [1, 7, 1000]],
];

describe("R6 SHA-1 state export/import", () => {
  it("after any prefix, the imported hasher finishes to the digest of the whole input", () => {
    const data = noise(3000, 11);
    const whole = Buffer.from(sha1(data)).toString("hex");
    for (let k = 0; k <= data.length; k += k < 200 ? 1 : 37) {
      const h = sha1.create().update(data.subarray(0, k));
      const g = importSha1(exportSha1(h)).update(data.subarray(k));
      expect(Buffer.from(g.digest()).toString("hex"), `split ${k}`).toBe(whole);
    }
    // exported twice along the way
    const h1 = importSha1(exportSha1(sha1.create().update(data.subarray(0, 100))));
    const h2 = importSha1(exportSha1(h1.update(data.subarray(100, 1999))));
    expect(Buffer.from(h2.update(data.subarray(1999)).digest()).toString("hex")).toBe(whole);
  });
});

describe("R1 a job run in cold steps installs what the one-shot run installs", () => {
  for (const [name, pack, unitsList] of packs) {
    it(name, async () => {
      const ref = await reference(pack);
      for (const units of unitsList) {
        const files = new MemFilesApi();
        const { result, steps } = await runJob(files, pack, units);
        expect(
          Buffer.compare(Buffer.from(result.idx), Buffer.from(ref.idx)),
          `units ${units}`,
        ).toBe(0);
        expect(result.packId).toBe(ref.packId);
        const bytes = await collect(files.read(`/p/pack-${result.packId}.pack`));
        expect(Buffer.compare(Buffer.from(bytes), Buffer.from(ref.pack))).toBe(0);
        expect(await listNames(files, "/p")).toEqual([
          `pack-${ref.packId}.idx`,
          `pack-${ref.packId}.pack`,
        ]);
        if (units === 1) expect(steps.length).toBeGreaterThan(result.count);
      }
    }, 300_000);
  }
  for (const [name, want, have] of [
    ["thin: last 5 commits of 30", "HEAD", "HEAD~5"],
    ["thin: one commit", "HEAD", "HEAD~1"],
  ] as const) {
    it(name, async () => {
      const { receiver, thin } = thinCase(history, want, have);
      const externalBase = await odbBase(receiver);
      const ref = await reference(thin, externalBase);
      for (const units of [1, 7, 1000]) {
        const files = new MemFilesApi();
        const { result } = await runJob(files, thin, units, { externalBase });
        expect(result.stats.appended).toBeGreaterThan(0);
        expect(result.packId).toBe(ref.packId);
        expect(
          Buffer.compare(Buffer.from(result.idx), Buffer.from(ref.idx)),
          `units ${units}`,
        ).toBe(0);
        const bytes = await collect(files.read(`/p/pack-${result.packId}.pack`));
        expect(Buffer.compare(Buffer.from(bytes), Buffer.from(ref.pack))).toBe(0);
      }
    }, 300_000);
  }
  it("a malformed pack ends the job with PackError and leaves nothing", async () => {
    const good = packAll(history, true);
    const bad = good.slice();
    bad[good.length - 1] = (bad[good.length - 1] as number) ^ 1; // trailer
    const files = new MemFilesApi();
    const err = await runJob(files, bad, 50).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(await listNames(files, "/p")).toEqual([]);
  });
});

/** Fails the n-th storage operation (a write fails after its first chunk: a torn file). */
function failing(files: FilesApi, n: number) {
  let count = 0;
  const hit = () => ++count === n;
  const f: FilesApi = Object.create(files);
  f.read = (p, o) => {
    if (hit())
      return (async function* () {
        yield* [];
        throw new Error(`injected read failure #${n}`);
      })();
    return files.read(p, o);
  };
  f.write = async (p, content) => {
    if (!hit()) return files.write(p, content);
    await files.write(
      p,
      (async function* () {
        for await (const c of content) {
          yield c.subarray(0, Math.ceil(c.length / 2));
          break;
        }
        throw new Error(`injected write failure #${n}`);
      })(),
    );
  };
  for (const m of ["remove", "move", "stats", "exists"] as const) {
    const orig = (files[m] as (...a: unknown[]) => Promise<unknown>).bind(files);
    (f as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
      if (hit()) throw new Error(`injected ${m} failure #${n}`);
      return orig(...a);
    };
  }
  return { files: f, count: () => count };
}

describe("R2 a crash inside a step: resume completes to the same result", () => {
  it("every storage operation of a job failed once, on Node files (torn writes)", async () => {
    const pack = packAll(repoWithHistory(8), true);
    const ref = await reference(pack);
    // operations of a clean run
    const probe = failing(new StreamingNodeFilesApi(tmp()), 0);
    await runJob(probe.files, pack, 25);
    const total = probe.count();
    expect(total).toBeGreaterThan(30);
    let crashed = 0;
    for (let n = 1; n <= total; n++) {
      const root = tmp();
      const healthy = new StreamingNodeFilesApi(root);
      const sick = failing(healthy, n).files;
      let id: string | undefined;
      let result: Awaited<ReturnType<typeof runJob>>["result"] | undefined;
      try {
        id = await startIndexJob(sick, "/p", chunks(pack));
        for (;;) {
          const r = await stepIndexJob(sick, "/p", id, { units: 25, cold: true });
          if (r.done) {
            result = r.result;
            break;
          }
        }
      } catch (e) {
        expect(e).not.toBeInstanceOf(PackError);
        crashed++;
      }
      if (!result) {
        if (!id) id = await startIndexJob(healthy, "/p", chunks(pack)); // the pack was not stored
        for (;;) {
          const r = await stepIndexJob(healthy, "/p", id, { units: 25, cold: true }).catch(
            (e: Error) => {
              throw new Error(`resume after failure #${n}: ${e.message}`);
            },
          );
          if (r.done) {
            result = r.result;
            break;
          }
        }
      }
      expect(Buffer.compare(Buffer.from(result.idx), Buffer.from(ref.idx)), `failure #${n}`).toBe(
        0,
      );
      expect(readdirSync(join(root, "p")).sort(), `failure #${n}`).toEqual([
        `pack-${ref.packId}.idx`,
        `pack-${ref.packId}.pack`,
      ]);
    }
    expect(crashed).toBeGreaterThan(total / 2);
  }, 600_000);
});

describe("R3 checkpoints are log-structured", () => {
  it("log bytes ≤ 2 × 79 per object; state and stack bytes a constant per step", async () => {
    const pack = packAll(history, true);
    const files = new MemFilesApi();
    const write = files.write.bind(files);
    const bytes = { log: 0, state: 0, stack: 0 };
    files.write = async (p, content) => {
      const kind = /_log_\d+$/.test(p)
        ? "log"
        : /_state_\d+$/.test(p)
          ? "state"
          : /_stack_\d+$/.test(p)
            ? "stack"
            : null;
      if (!kind) return write(p, content);
      const parts = await collect(content as AsyncIterable<Uint8Array>);
      bytes[kind] += parts.length;
      return write(p, [parts]);
    };
    const { result, steps } = await runJob(files, pack, 7);
    console.log(`R3: ${result.count} objects, ${steps.length} steps, ${JSON.stringify(bytes)}`);
    expect(bytes.log).toBeLessThanOrEqual(2 * 79 * result.count);
    expect(bytes.state).toBeLessThanOrEqual((steps.length + 2) * 2048);
    expect(bytes.stack).toBeLessThanOrEqual(steps.length * (4 + 17 * 64));
  }, 300_000);
});

describe("R4 a step's work is bounded by its budget", () => {
  it("units: no step uses more than its units; the job takes at least total/U steps", async () => {
    const pack = packAll(history, true);
    for (const U of [1, 7, 50]) {
      const { steps, result } = await runJob(new MemFilesApi(), pack, U);
      for (const s of steps) expect(s.units).toBeLessThanOrEqual(U);
      const total = steps.reduce((a, s) => a + s.units, 0);
      expect(total).toBeGreaterThanOrEqual(result.count); // every entry parsed is a unit
      expect(steps.length).toBeGreaterThanOrEqual(Math.ceil(total / U));
    }
  }, 300_000);
  it("budgetMs: a warm step's work ends within the budget plus one unit", async () => {
    const enc = new TextEncoder();
    const e: CraftEntry[] = [];
    for (let i = 0; i < 40_000; i++)
      e.push({ kind: 3, data: enc.encode(`blob ${i} ${"y".repeat(40)}`) });
    const pack = buildPack(e);
    const { steps } = await runJob(new MemFilesApi(), pack, Number.POSITIVE_INFINITY, {
      budgetMs: 20,
      cold: false,
    });
    expect(steps.length).toBeGreaterThan(3);
    for (const s of steps.slice(0, -1)) expect(s.workMs).toBeLessThanOrEqual(20 + s.maxUnitMs + 5);
  }, 300_000);
});

describe("R5 inside a Durable Object, the runtime restarted between steps", () => {
  it("X6a's fixture pack, steps of 40 units, a fresh Miniflare for every step: git's .idx", async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../src/do-entry.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
      loader: { ".pack": "binary", ".idx": "binary" },
    });
    const persist = tmp();
    const runtime = () =>
      new Miniflare({
        modules: true,
        script: out.outputFiles[0]?.text ?? "",
        compatibilityDate: "2026-07-01",
        durableObjectsPersist: persist,
        durableObjects: { PACKS: { className: "PacksDo", useSQLite: true } },
      });
    const call = async (path: string) => {
      const mf = runtime();
      try {
        return (await (await mf.dispatchFetch(`http://x${path}`, { method: "POST" })).json()) as {
          id?: string;
          done?: boolean;
          same?: boolean;
          names?: string[];
          error?: string;
        };
      } finally {
        await mf.dispose(); // the isolate and everything in memory are gone
      }
    };
    const start = await call("/start");
    expect(start.error).toBeUndefined();
    let steps = 0;
    for (;;) {
      const r = await call(`/step?id=${start.id}&units=40`);
      expect(r.error).toBeUndefined();
      steps++;
      if (r.done) {
        expect(r.same).toBe(true);
        expect(r.names?.every((n) => n.startsWith("pack-"))).toBe(true);
        break;
      }
      expect(steps).toBeLessThan(200);
    }
    expect(steps).toBeGreaterThan(5);
  }, 600_000);
});
