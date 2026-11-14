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
    if (steps.length > 20_000) throw new Error("no progress");
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

describe("R2b storage that loses or corrupts a checkpoint is detected, never replayed", () => {
  const steps = async (files: FilesApi, id: string, k: number) => {
    for (let i = 0; i < k; i++) await stepIndexJob(files, "/p", id, { units: 20, cold: true });
  };
  it("a missing log segment fails the resume (it would replay as zeroed entries)", async () => {
    const files = new MemFilesApi();
    const id = await startIndexJob(files, "/p", chunks(packAll(history, true)));
    await steps(files, id, 4);
    const logs = (await listNames(files, "/p")).filter((n) => n.includes("_log_"));
    expect(logs.length).toBeGreaterThan(1);
    await files.remove(`/p/${logs[0]}`);
    await expect(stepIndexJob(files, "/p", id, { units: 20, cold: true })).rejects.toThrow(
      /missing or torn/,
    );
  });
  it("a log segment truncated by one record fails the resume", async () => {
    const files = new MemFilesApi();
    const id = await startIndexJob(files, "/p", chunks(packAll(history, true)));
    await steps(files, id, 4);
    const log = (await listNames(files, "/p")).find((n) => n.includes("_log_")) as string;
    const bytes = await collect(files.read(`/p/${log}`));
    await files.write(`/p/${log}`, [bytes.subarray(0, bytes.length - 79)]); // whole records only
    await expect(stepIndexJob(files, "/p", id, { units: 20, cold: true })).rejects.toThrow(
      /missing or torn/,
    );
  });
  it("a corrupted digit in the newest state is rejected by its checksum", async () => {
    const files = new MemFilesApi();
    const id = await startIndexJob(files, "/p", chunks(packAll(history, true)));
    await steps(files, id, 3);
    const state = (await listNames(files, "/p")).find((n) => n.includes("_state_")) as string;
    const text = new TextDecoder().decode(await collect(files.read(`/p/${state}`)));
    const bad = text.replace(/"i":(\d+)/, (_, d) => `"i":${Number(d) + 1}`);
    expect(bad).not.toBe(text);
    await files.write(`/p/${state}`, [new TextEncoder().encode(bad)]);
    await expect(stepIndexJob(files, "/p", id, { units: 20, cold: true })).rejects.toThrow(
      /no index job/,
    );
  });
});

describe("R3 checkpoints are log-structured", () => {
  it("log bytes ≤ 2 × 79 per object; state and stack bytes a constant per step", async () => {
    const pack = packAll(history, true);
    const files = new MemFilesApi();
    const write = files.write.bind(files);
    const bytes = { log: 0, state: 0, stack: 0, maxState: 0 };
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
      if (kind === "state") bytes.maxState = Math.max(bytes.maxState, parts.length);
      return write(p, [parts]);
    };
    const { result, steps } = await runJob(files, pack, 7);
    console.log(`R3: ${result.count} objects, ${steps.length} steps, ${JSON.stringify(bytes)}`);
    // each segment: an 8-byte header and 79 bytes per entry created or resolved in its step
    expect(bytes.log).toBeLessThanOrEqual(2 * 79 * result.count + 8 * steps.length);
    expect(bytes.maxState).toBeLessThanOrEqual(1024); // the same size whatever the step count
    expect(bytes.state).toBeLessThanOrEqual((steps.length + 2) * 1024);
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

/** Review of #70: two failures, concurrent steppers, tiny budgets, thin-phase state, warm work. */
describe("review cases (#70)", () => {
  const enc = new TextEncoder();
  it("B1: an older state left behind plus a failed removal in cleanup: the job still completes", async () => {
    const pack = packAll(history, true);
    const ref = await reference(pack);
    const healthy = new MemFilesApi();
    // removing the last state file left in the directory fails (cleanup's final removal)
    const sick: FilesApi = Object.create(healthy);
    sick.remove = async (p) => {
      if (/_state_\d+$/.test(p)) {
        const states = (await listNames(healthy, "/p")).filter((n) => n.includes("_state_"));
        if (states.length === 1) throw new Error("injected: last state removal fails");
      }
      return healthy.remove(p);
    };
    const id = await startIndexJob(sick, "/p", chunks(pack));
    let saved: [string, Uint8Array] | undefined;
    let result: Awaited<ReturnType<typeof runJob>>["result"] | undefined;
    try {
      for (;;) {
        const r = await stepIndexJob(sick, "/p", id, { units: 5, cold: true });
        if (r.done) {
          result = r.result;
          break;
        }
        const names = await listNames(healthy, "/p");
        const st = names.find((n) => n.endsWith("_state_9"));
        if (st && !saved) saved = [st, await collect(healthy.read(`/p/${st}`))];
        // a commit whose removal of the previous state failed (swallowed): state_9 stays behind
        if (saved && !names.includes(saved[0])) await healthy.write(`/p/${saved[0]}`, [saved[1]]);
      }
    } catch {
      // the injected failure in cleanup
    }
    expect(saved).toBeDefined();
    if (!result) {
      for (;;) {
        const r = await stepIndexJob(healthy, "/p", id, { units: 5, cold: true });
        if (r.done) {
          result = r.result;
          break;
        }
      }
    }
    expect(Buffer.compare(Buffer.from(result.idx), Buffer.from(ref.idx))).toBe(0);
    expect(await listNames(healthy, "/p")).toEqual([
      `pack-${ref.packId}.idx`,
      `pack-${ref.packId}.pack`,
    ]);
  }, 300_000);

  /** 0–3 ms of latency on every storage operation, so concurrent steps interleave. */
  const slow = (files: FilesApi): FilesApi => {
    const f: FilesApi = Object.create(files);
    const nap = () => new Promise((r) => setTimeout(r, Math.random() * 3));
    f.read = (p, o) =>
      (async function* () {
        await nap();
        yield* files.read(p, o);
      })();
    for (const m of ["write", "remove", "move", "stats", "exists"] as const) {
      const orig = (files[m] as (...a: unknown[]) => Promise<unknown>).bind(files);
      (f as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
        await nap();
        return orig(...a);
      };
    }
    f.list = (p, o) =>
      (async function* () {
        await nap();
        yield* files.list(p, o);
      })();
    return f;
  };
  it("B2: two concurrent steppers in one isolate never corrupt or wedge the job", async () => {
    const pack = packAll(repoWithHistory(8), true);
    const ref = await reference(pack);
    for (const [ua, ub, cold] of [
      [5, 40, false],
      [40, 5, true],
      [1, 1000, false],
      [3, 9, true],
    ] as const) {
      for (let pre = 0; pre < 8; pre++) {
        const files = slow(new MemFilesApi()); // two isolates' interleaving at I/O
        const id = await startIndexJob(files, "/p", chunks(pack));
        for (let k = 0; k < pre; k++) await stepIndexJob(files, "/p", id, { units: 10 });
        const pair = await Promise.all([
          stepIndexJob(files, "/p", id, { units: ua, cold }),
          stepIndexJob(files, "/p", id, { units: ub, cold }),
        ]);
        let idx = pair.find((p) => p.done)?.done
          ? (pair.find((p) => p.done) as { result: { idx: Uint8Array } }).result.idx
          : undefined;
        for (let n = 0; !idx; n++) {
          const r = await stepIndexJob(files, "/p", id, { units: 10 });
          if (r.done) idx = r.result.idx;
          expect(n).toBeLessThan(10_000);
        }
        expect(
          Buffer.compare(Buffer.from(idx), Buffer.from(ref.idx)),
          `${ua}/${ub}/${cold}/${pre}`,
        ).toBe(0);
        expect(await listNames(files, "/p"), `${ua}/${ub}/${cold}/${pre}`).toEqual([
          `pack-${ref.packId}.idx`,
          `pack-${ref.packId}.pack`,
        ]);
      }
    }
  }, 300_000);

  /** `n` blobs, each with a REF_DELTA child: resolve-phase setup is real work. */
  const refHeavy = (n: number) => {
    const e: CraftEntry[] = [];
    for (let i = 0; i < n; i++) {
      const data = enc.encode(`blob ${i} ${"y".repeat(40)}`);
      e.push({ kind: 3, data });
      const t = enc.encode(String(i).padStart(10, "0"));
      e.push({
        kind: 7,
        baseOid: oidOf("blob", data),
        data: delta(data.length, 20, [0x80 | 0x10, 10, t.length, ...t]),
      });
    }
    return buildPack(e);
  };
  it("B3: budgetMs 0 (the deadline passed before the first unit): each step still does one unit", async () => {
    const pack = refHeavy(300);
    const ref = await reference(pack);
    for (const cold of [false, true]) {
      const { steps, result } = await runJob(new MemFilesApi(), pack, Number.POSITIVE_INFINITY, {
        budgetMs: 0,
        cold,
      });
      for (const s of steps.slice(0, -1)) expect(s.units).toBe(1);
      expect(Buffer.compare(Buffer.from(result.idx), Buffer.from(ref.idx))).toBe(0);
    }
  }, 300_000);
  for (const cold of [false, true]) {
    it(`B3: budgetMs 2 (${cold ? "cold" : "warm"}): every step makes progress and the job completes`, async () => {
      // cold steps replay the whole log first: a smaller pack keeps a 1-unit-per-step job short
      const pack = refHeavy(cold ? 1_500 : 20_000);
      const ref = await reference(pack);
      const { steps, result } = await runJob(new MemFilesApi(), pack, Number.POSITIVE_INFINITY, {
        budgetMs: 2,
        cold,
      });
      for (const s of steps.slice(0, -1)) expect(s.units).toBeGreaterThanOrEqual(1);
      expect(Buffer.compare(Buffer.from(result.idx), Buffer.from(ref.idx))).toBe(0);
    }, 600_000);
  }

  it("C1: a thin pack with 300 bases, 1-unit steps: state stays small, a few thin files", async () => {
    const bases: Record<string, Uint8Array> = {};
    const e: CraftEntry[] = [];
    for (let k = 0; k < 300; k++) {
      const A = enc.encode(`external base ${k} `.repeat(30));
      bases[oidOf("blob", A)] = A;
      const t = enc.encode(`+${k}`);
      e.push({
        kind: 7,
        baseOid: oidOf("blob", A),
        data: delta(A.length, A.length + t.length, [
          0x80 | 0x10 | 0x20,
          A.length & 255,
          A.length >> 8,
          t.length,
          ...t,
        ]),
      });
    }
    const pack = buildPack(e);
    const externalBase: ExternalBase = async (o) =>
      bases[o] ? { type: "blob", data: bases[o] } : undefined;
    const ref = await reference(pack, externalBase);
    const files = new MemFilesApi();
    const write = files.write.bind(files);
    let maxState = 0;
    const thinFiles = new Set<string>();
    files.write = async (p, content) => {
      if (/_state_\d+$/.test(p)) {
        const b = await collect(content as AsyncIterable<Uint8Array>);
        maxState = Math.max(maxState, b.length);
        return write(p, [b]);
      }
      if (/tmp_thin_/.test(p)) thinFiles.add(p);
      return write(p, content);
    };
    const { result, steps } = await runJob(files, pack, 1, { externalBase });
    console.log(`C1: ${steps.length} steps, max state ${maxState} B, ${thinFiles.size} thin files`);
    expect(Buffer.compare(Buffer.from(result.idx), Buffer.from(ref.idx))).toBe(0);
    expect(maxState).toBeLessThanOrEqual(1024);
    expect(thinFiles.size).toBeLessThanOrEqual(2);
    expect(await listNames(files, "/p")).toEqual([
      `pack-${ref.packId}.idx`,
      `pack-${ref.packId}.pack`,
    ]);
  }, 300_000);

  it("C2: warm steps keep the resolver: a 3 000-deep comb in steps of 50 loads ≤ 2× the one-shot", async () => {
    const pack = comb(3000);
    const one = await installX6b1(new MemFilesApi(), "/p", chunks(pack));
    const { result } = await runJob(new MemFilesApi(), pack, 50, { cold: false });
    console.log(
      `C2: one-shot ${one.stats.deltaLoads} loads, warm steps ${result.stats.deltaLoads}`,
    );
    expect(Buffer.compare(Buffer.from(result.idx), Buffer.from(one.idx))).toBe(0);
    expect(result.stats.deltaLoads).toBeLessThanOrEqual(2 * one.stats.deltaLoads);
  }, 300_000);
});
