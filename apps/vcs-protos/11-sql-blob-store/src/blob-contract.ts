/**
 * X3b BlobStore contract, runnable in Node, Chromium and a Durable Object. Cases 1–15 port
 * webrun-storage's tests/blob-store.test.ts one to one; the rest cover what that suite does not:
 * empty blobs, multi-row content, ranges at row boundaries, putStaged and sweepStaged.
 */
import type { StagingBlobStore } from "../../09-git-objects/src/staging.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
async function* streamOf(...parts: (string | Uint8Array)[]) {
  for (const p of parts) yield typeof p === "string" ? enc.encode(p) : p;
}
async function collect(s: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const text = async (s: AsyncIterable<Uint8Array>) => dec.decode(await collect(s));
async function sha256(s: AsyncIterable<Uint8Array>): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", (await collect(s)) as Uint8Array<ArrayBuffer>),
  );
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}
async function ids(s: StagingBlobStore, prefix?: string) {
  const out: string[] = [];
  for await (const id of s.list(prefix)) out.push(id);
  return out.sort();
}
/** Deterministic bytes: `n` bytes of a xorshift stream. */
export function pattern(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 255;
  }
  return out;
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** `chunkSize` is the store's row size, so multi-row cases are really multi-row. */
export async function runBlobContract(
  make: () => Promise<StagingBlobStore>,
  chunkSize: number,
): Promise<{ cases: number; failed: string[] }> {
  const failed: string[] = [];
  let cases = 0;
  const check = async (name: string, fn: (s: StagingBlobStore) => Promise<boolean | string>) => {
    cases++;
    try {
      const r = await fn(await make());
      if (r !== true) failed.push(r === false ? name : `${name}: ${r}`);
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  };
  // --- webrun-storage's suite
  await check("put/get roundtrip", async (s) => {
    await s.put("a1", streamOf("hello ", "world"));
    return (await text(s.get("a1"))) === "hello world";
  });
  await check("has reflects presence", async (s) => {
    const before = await s.has("a1");
    await s.put("a1", streamOf("x"));
    return !before && (await s.has("a1"));
  });
  await check("remove deletes and reports whether anything was removed", async (s) => {
    await s.put("a1", streamOf("x"));
    return (await s.remove("a1")) && !(await s.has("a1")) && !(await s.remove("a1"));
  });
  await check("re-put of the same id is idempotent (no error, content preserved)", async (s) => {
    await s.put("a1", streamOf("payload"));
    await s.put("a1", streamOf("payload"));
    return (await text(s.get("a1"))) === "payload";
  });
  await check(
    "get of an absent id yields an empty stream, not an error",
    async (s) => (await collect(s.get("missing"))).length === 0,
  );
  await check("list(prefix) returns only matching ids", async (s) => {
    await s.put("aa11", streamOf("1"));
    await s.put("aa22", streamOf("2"));
    await s.put("bb33", streamOf("3"));
    return (
      (await ids(s)).join() === "aa11,aa22,bb33" && (await ids(s, "aa")).join() === "aa11,aa22"
    );
  });
  await check("integrity: verify accepts a matching id", async (s) => {
    const id = await sha256(streamOf("content"));
    await s.put(id, streamOf("content"), { verify: sha256 });
    return (await text(s.get(id))) === "content";
  });
  await check("integrity: verify rejects a mismatching id and stores nothing", async (s) => {
    const r = await rejects(s.put("not-the-hash", streamOf("content"), { verify: sha256 }));
    return r && !(await s.has("not-the-hash")) && (await ids(s)).length === 0;
  });
  await check("get(range): full read with no range is unchanged", async (s) => {
    await s.put("a1", streamOf("0123456789"));
    return (await text(s.get("a1"))) === "0123456789";
  });
  await check("get(range): start+end returns the [start,end) slice (end exclusive)", async (s) => {
    await s.put("a1", streamOf("0123456789"));
    return (await text(s.get("a1", { start: 2, end: 5 }))) === "234";
  });
  await check("get(range): start-only reads from start to end of content", async (s) => {
    await s.put("a1", streamOf("0123456789"));
    return (await text(s.get("a1", { start: 7 }))) === "789";
  });
  await check("get(range): end-only reads from 0 to end (exclusive)", async (s) => {
    await s.put("a1", streamOf("0123456789"));
    return (await text(s.get("a1", { end: 4 }))) === "0123";
  });
  await check("get(range): slice spanning multiple stored chunks", async (s) => {
    await s.put("a1", streamOf("012", "345", "678", "9"));
    return (await text(s.get("a1", { start: 2, end: 8 }))) === "234567";
  });
  await check("size: returns the stored byte length", async (s) => {
    await s.put("a1", streamOf("hello ", "world"));
    return (await s.size("a1")) === 11;
  });
  await check("size: returns -1 for an absent id", async (s) => (await s.size("missing")) === -1);
  // --- beyond webrun-storage's suite
  await check("an empty blob is present, has size 0 and reads as nothing", async (s) => {
    await s.put("e", streamOf());
    return (
      (await s.has("e")) && (await s.size("e")) === 0 && (await collect(s.get("e"))).length === 0
    );
  });
  await check("multi-row content round-trips; ranges at and across row boundaries", async (s) => {
    const data = pattern(chunkSize * 3 + 17);
    await s.put("big", streamOf(data.subarray(0, 5), data.subarray(5)));
    if (!eq(await collect(s.get("big")), data)) return "whole";
    if ((await s.size("big")) !== data.length) return "size";
    const cuts: [number, number][] = [
      [0, chunkSize],
      [chunkSize, 2 * chunkSize],
      [chunkSize - 1, chunkSize + 1],
      [2 * chunkSize + 3, data.length],
      [5, 5],
      [data.length, data.length],
    ];
    for (const [a, b] of cuts) {
      if (!eq(await collect(s.get("big", { start: a, end: b })), data.subarray(a, b)))
        return `range ${a}-${b}`;
    }
    return true;
  });
  await check("putStaged commits under the id idOf returns after the last byte", async (s) => {
    const data = pattern(chunkSize * 2 + 1, 3);
    let seen = 0;
    async function* src() {
      for (let i = 0; i < data.length; i += 1000) {
        seen += Math.min(1000, data.length - i);
        yield data.subarray(i, i + 1000);
      }
    }
    const r = await s.putStaged(src(), () =>
      seen === data.length ? "staged-id" : `early-${seen}`,
    );
    return (
      (r.id === "staged-id" &&
        r.stored &&
        eq(await collect(s.get("staged-id")), data) &&
        (await ids(s)).join() === "staged-id") ||
      JSON.stringify(r)
    );
  });
  await check(
    "putStaged: a failing stream or idOf stores nothing and leaves nothing to list",
    async (s) => {
      async function* failing() {
        yield pattern(chunkSize + 10);
        throw new Error("source died");
      }
      const a = await rejects(s.putStaged(failing(), () => "x1"));
      const b = await rejects(
        s.putStaged(streamOf(pattern(chunkSize * 2 + 1)), () => {
          throw new Error("bad id");
        }),
      );
      const left = (await s.sweepStaged?.(0)) ?? 0;
      return (
        (a && b && left === 0 && (await ids(s)).length === 0 && !(await s.has("x1"))) ||
        `leftovers ${left}`
      );
    },
  );
  await check("putStaged: an existing blob wins, the staged copy is dropped", async (s) => {
    await s.put("k", streamOf("first"));
    const r = await s.putStaged(streamOf("second"), () => "k");
    return !r.stored && (await text(s.get("k"))) === "first" && (await ids(s)).join() === "k";
  });
  await check(
    "sweepStaged removes temporaries left by an interrupted put, and nothing else",
    async (s) => {
      await s.put("keep", streamOf("kept"));
      // never resolved: the put stays half-written, as after a crash (resuming it after a sweep would
      // commit a blob with missing rows — the same hazard as `git prune` of an active tmp file)
      const gate = new Promise<void>(() => {});
      async function* stuck() {
        yield pattern(chunkSize + 5);
        await gate; // never released: the put stays half-written
      }
      void s.putStaged(stuck(), () => "never").catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      const tooYoung = (await s.sweepStaged?.(3_600_000)) ?? -1; // younger than an hour: kept
      const removed = (await s.sweepStaged?.(0)) ?? -1;
      if (tooYoung !== 0) return `swept a fresh temporary (${tooYoung})`;
      return (
        (removed >= 1 &&
          (await ids(s)).join() === "keep" &&
          (await text(s.get("keep"))) === "kept") ||
        `removed ${removed}`
      );
    },
  );
  await check(
    "10 concurrent staged puts of one id leave one blob and no temporary rows",
    async (s) => {
      const data = pattern(chunkSize * 2 + 3, 11);
      const r = await Promise.all(
        Array.from({ length: 10 }, () => s.putStaged(streamOf(data), () => "same")),
      );
      const stored = r.filter((x) => x.stored).length;
      const left = (await s.sweepStaged?.(0)) ?? -1;
      return (
        (stored === 1 &&
          left === 0 &&
          eq(await collect(s.get("same")), data) &&
          (await ids(s)).join() === "same") ||
        `stored ${stored}, leftovers ${left}`
      );
    },
  );
  return { cases, failed };
}
