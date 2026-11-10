import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runKvContract } from "../src/kv-contract.js";
import { sqlKvStore } from "../src/sql-kv-store.js";

const enc = new TextEncoder();
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x3a-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("R1 the webrun-storage KvStore contract on node:sqlite", () => {
  it("in memory", async () => {
    const r = await runKvContract(async () => sqlKvStore(await newNodeSqliteDb()));
    expect(r.cases).toBe(9);
    expect(r.failed).toEqual([]);
  });
  it("on a file", async () => {
    const path = join(tmp(), "kv.sqlite");
    const r = await runKvContract(async () => sqlKvStore(await newNodeSqliteDb({ path })));
    expect(r.failed).toEqual([]);
  });
});

describe("R2 100 concurrent cas on one Db", () => {
  it("exactly one winner, final value is the winner's", async () => {
    const kv = await sqlKvStore(await newNodeSqliteDb());
    await kv.put("ref", enc.encode("v0"));
    const r = await Promise.all(
      Array.from({ length: 100 }, (_, i) => kv.cas("ref", enc.encode("v0"), enc.encode(`w${i}`))),
    );
    const winners = r.flatMap((ok, i) => (ok ? [i] : []));
    expect(winners.length).toBe(1);
    expect(new TextDecoder().decode(await kv.get("ref"))).toBe(`w${winners[0]}`);
  });
});

describe("R3 several connections and processes on one file", () => {
  it("two connections, interleaved: exactly one winner", async () => {
    const path = join(tmp(), "kv.sqlite");
    const [a, b] = await Promise.all([newNodeSqliteDb({ path }), newNodeSqliteDb({ path })]);
    const [ka, kb] = [await sqlKvStore(a), await sqlKvStore(b)];
    await ka.put("ref", enc.encode("v0"));
    const r = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 ? ka : kb).cas("ref", enc.encode("v0"), enc.encode(`c${i}`)),
      ),
    );
    expect(r.filter(Boolean).length).toBe(1);
    await a.close();
    await b.close();
  });

  const race = async (busyMs: number) => {
    const path = join(tmp(), "kv.sqlite");
    const setup = await newNodeSqliteDb({ path });
    await (await sqlKvStore(setup)).put("refs/heads/main", enc.encode("v0"));
    await setup.close();
    const child = join(import.meta.dirname, "race-child.ts");
    const startAt = Date.now() + 1500;
    return Promise.all(
      Array.from(
        { length: 4 },
        (_, i) =>
          new Promise<string>((resolve, reject) => {
            const p = spawn(
              process.execPath,
              ["--import", "tsx", child, path, String(i), String(busyMs)],
              {
                env: { ...process.env, START_AT: String(startAt) },
              },
            );
            let out = "";
            let err = "";
            p.stdout.on("data", (d) => (out += d));
            p.stderr.on("data", (d) => (err += d));
            p.on("error", reject);
            p.on("close", (code) =>
              code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err}`)),
            );
          }),
      ),
    );
  };
  it("four processes, no busy timeout: at most one ok; contention surfaces as an explicit busy error, never a wrong ok", async () => {
    const outs = await race(0);
    console.log("no busy timeout:", outs.join(" "));
    expect(
      outs.every((o) => /:(ok|mismatch|busy)$/.test(o)),
      outs.join(" "),
    ).toBe(true);
    expect(outs.filter((o) => o.endsWith(":ok")).length).toBeLessThanOrEqual(1);
  }, 60_000);
  it("four processes with PRAGMA busy_timeout = 5000: exactly one ok, the rest mismatch", async () => {
    const outs = await race(5000);
    console.log("busy timeout 5000:", outs.join(" "));
    expect(outs.filter((o) => o.endsWith(":ok")).length, outs.join(" ")).toBe(1);
    expect(outs.filter((o) => o.endsWith(":mismatch")).length, outs.join(" ")).toBe(3);
  }, 60_000);
});

describe("R5 Durable Object on workerd (Miniflare, SQLite-backed class)", () => {
  let mf: Miniflare;
  beforeAll(async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../src/do-entry.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-07-01",
      durableObjects: { KV: { className: "KvDo", useSQLite: true } },
    });
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
  });

  it("R1 contract inside the Durable Object", async () => {
    const r = (await (
      await mf.dispatchFetch("http://x/contract?ns=contract", { method: "POST" })
    ).json()) as {
      cases: number;
      failed: string[];
    };
    expect(r.cases).toBe(9);
    expect(r.failed).toEqual([]);
  });
  it("100 concurrent requests, one cas each: exactly one winner", async () => {
    const b64 = (s: string) => btoa(s);
    const post = (body: unknown) =>
      mf
        .dispatchFetch("http://x/cas?ns=race", { method: "POST", body: JSON.stringify(body) })
        .then((r) => r.json());
    expect(await post({ key: "ref", expected: null, next: b64("v0") })).toEqual({ ok: true });
    const r = (await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        post({ key: "ref", expected: b64("v0"), next: b64(`d${i}`) }),
      ),
    )) as Array<{ ok: boolean }>;
    const winners = r.flatMap((x, i) => (x.ok ? [i] : []));
    expect(winners.length).toBe(1);
    const got = (await (await mf.dispatchFetch("http://x/get?ns=race&key=ref")).json()) as {
      value: string;
    };
    expect(atob(got.value)).toBe(`d${winners[0]}`);
  }, 60_000);
  it("R6 1 MiB values round-trip; a value above the ~2 MB row limit is recorded", async () => {
    const size = async (n: number) =>
      (await (
        await mf.dispatchFetch(`http://x/put-size?ns=size&bytes=${n}`, { method: "POST" })
      ).json()) as {
        ok: boolean;
        error?: string;
      };
    expect(await size(1 << 20)).toEqual({ ok: true });
    const big = await size(3 << 20);
    console.log("3 MiB value in a Durable Object:", JSON.stringify(big));
    expect(typeof big.ok).toBe("boolean");
  }, 60_000);
});

describe("extra: statewalker-db's strict Durable Object fake (DO limits on node:sqlite)", () => {
  it("R1 contract holds under the DO limits (no BEGIN/PRAGMA, ArrayBuffer BLOBs, 100 params)", async () => {
    const r = await runKvContract(async () => sqlKvStore(newDoSqliteDb(newFakeDoStorage())));
    expect(r.failed).toEqual([]);
  });
  it("R6 a 3 MiB value is rejected by the DO limit, not stored", async () => {
    const kv = await sqlKvStore(newDoSqliteDb(newFakeDoStorage()));
    await expect(kv.put("big", new Uint8Array(3 << 20))).rejects.toThrow();
    expect(await kv.get("big")).toBeUndefined();
  });
});

describe("R6 1 MiB values on node:sqlite", () => {
  it("round-trips", async () => {
    const kv = await sqlKvStore(await newNodeSqliteDb());
    const v = new Uint8Array(1 << 20).map((_, i) => i & 0xff);
    await kv.put("big", v);
    const back = await kv.get("big");
    expect(back?.length).toBe(v.length);
    expect(Buffer.from(back ?? []).equals(Buffer.from(v))).toBe(true);
  });
});
