/**
 * X1e checks and benches, portable: given compiled modules and X0a's fixtures, run every reference
 * comparison. Used in Node, a Chromium page and worker, and workerd.
 */
import { createSha1 } from "../../01-streaming-git-hash/src/git-object-hash.js";
import { createBlake3, createSha256, toHex } from "../../03-sha256-blake3/src/hashes.js";
import type { BenchRow, Check, Fixtures } from "../../05-runtime-matrix/src/types.js";
import { base64ToBytes, createWasmHasher, type Hasher, type WasmModules } from "./wasm-hasher.js";

export const WASM_BENCH_NAMES = [
  "blake3-wasm",
  "blake3-noble",
  "sha1-wasm",
  "sha1-noble",
  "sha256-wasm",
  "sha256-noble",
] as const;

function* chunked(bytes: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let pos = 0; pos < bytes.length; pos += size) yield bytes.subarray(pos, pos + size);
}
const vectorInput = (len: number) => Uint8Array.from({ length: len }, (_, i) => i % 251);
const feed = (h: Hasher, parts: Iterable<Uint8Array>) => {
  for (const p of parts) h.update(p);
  return toHex(h.digest());
};

export async function runWasmConformance(fx: Fixtures, modules: WasmModules): Promise<Check[]> {
  const checks: Check[] = [];
  const check = async (name: string, fn: () => Promise<string | undefined>) => {
    try {
      const problem = await fn();
      checks.push(
        problem ? { name, ok: false, detail: `${problem} (seed ${fx.seed})` } : { name, ok: true },
      );
    } catch (e) {
      checks.push({ name, ok: false, detail: `threw: ${String(e)} (seed ${fx.seed})` });
    }
  };
  const key = new TextEncoder().encode(fx.blake3.key);

  for (const mode of ["hash", "keyed_hash"] as const) {
    for (const c of fx.blake3.cases) {
      await check(`blake3-wasm:${mode}:${c.input_len}`, async () => {
        const h = await createWasmHasher(modules.blake3, "blake3", {
          dkLen: c[mode].length / 2,
          ...(mode === "keyed_hash" ? { key } : {}),
        });
        return feed(h, chunked(vectorInput(c.input_len), 1000)) === c[mode]
          ? undefined
          : "mismatch";
      });
    }
  }
  await check("blake3-wasm:derive_key-rejected", async () => {
    try {
      await createWasmHasher(modules.blake3, "blake3", {
        context: new TextEncoder().encode(fx.blake3.context),
      });
      return "derive_key was accepted";
    } catch (e) {
      return /derive_key/.test(String(e)) ? undefined : `wrong error: ${String(e)}`;
    }
  });

  const enc = new TextEncoder();
  for (const o of fx.gitObjects) {
    await check(`sha1-wasm:git:${o.name}`, async () => {
      const bytes = base64ToBytes(o.b64);
      const h = await createWasmHasher(modules.sha1, "sha1");
      h.update(enc.encode(`${o.type} ${bytes.length}\0`));
      const id = feed(h, [bytes]); // one update: the 300 KiB blob crosses the 16 KiB buffer

      return id === o.id ? undefined : `got ${id}, git says ${o.id}`;
    });
  }
  for (const s of fx.sha256) {
    await check(`sha256-wasm:${s.name}`, async () => {
      const h = await createWasmHasher(modules.sha256, "sha256");
      return feed(h, chunked(base64ToBytes(s.b64), 65536)) === s.hex ? undefined : "mismatch";
    });
  }

  // Chunking across the 16 KiB transfer buffer: SHA-256 against node:crypto's value in the fixture,
  // BLAKE3 and SHA-1 against noble (their official references are checked above with one update).
  const bigFixture = fx.sha256.find((s) => s.name === "256 KiB random");
  const big = base64ToBytes(bigFixture?.b64 ?? "");
  const cases: Array<[string, number[]]> = [
    ["chunking:one 256 KiB update", [big.length]],
    ["chunking:16383/16384/16385 splits", [16383, 16384, 16385]],
    ["chunking:1-byte then 40000-byte", [1, 40000]],
  ];
  for (const [name, sizes] of cases) {
    await check(name, async () => {
      if (!bigFixture || big.length !== 256 * 1024)
        return "fixture '256 KiB random' missing or resized";
      const parts: Uint8Array[] = [];
      for (let pos = 0, i = 0; pos < big.length; i++) {
        const n = sizes[i % sizes.length] ?? 1;
        parts.push(big.subarray(pos, pos + n));
        pos += n;
      }
      const results = [
        feed(await createWasmHasher(modules.blake3, "blake3"), parts) ===
          feed(createBlake3(), [big]),
        feed(await createWasmHasher(modules.sha1, "sha1"), parts) ===
          feed(createSha1("noble"), [big]),
        feed(await createWasmHasher(modules.sha256, "sha256"), parts) ===
          feed(createSha256(), [big]),
      ];
      return results.every(Boolean) ? undefined : `per-algorithm results ${results.join(",")}`;
    });
  }

  await check("concurrent:two interleaved hashers", async () => {
    const a = vectorInput(50_000);
    const b = vectorInput(70_000).reverse();
    const ha = await createWasmHasher(modules.blake3, "blake3", { key });
    const hb = await createWasmHasher(modules.blake3, "blake3", { key });
    const pa = [...chunked(a, 7000)];
    const pb = [...chunked(b, 9000)];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i];
      const y = pb[i];
      if (x) ha.update(x);
      if (y) hb.update(y);
    }
    const ok =
      toHex(ha.digest()) === feed(createBlake3({ key }), [a]) &&
      toHex(hb.digest()) === feed(createBlake3({ key }), [b]);
    return ok ? undefined : "interleaved digests differ from references";
  });
  await check("finalized:update and digest throw after digest", async () => {
    // A second Hash_Final on these binaries returns a wrong value silently, so the guard matters.
    const h = await createWasmHasher(modules.sha1, "sha1");
    h.update(enc.encode("x"));
    h.digest();
    const threw = (fn: () => unknown) => {
      try {
        fn();
        return false;
      } catch {
        return true;
      }
    };
    return threw(() => h.update(enc.encode("y"))) && threw(() => h.digest())
      ? undefined
      : "no error after digest";
  });
  return checks;
}

// Built once per isolate so the workerd timing (measured from outside) excludes its construction.
const BENCH_BUF = Uint8Array.from({ length: 65536 }, (_, i) => (i * 31 + 7) & 0xff);

export async function runWasmBench(name: string, modules: WasmModules): Promise<BenchRow> {
  // WASM runs take ~25 ms at 16 MiB, too short to time; noble BLAKE3 takes ~1 s at 16 MiB.
  const mib = name.endsWith("-wasm") ? 128 : name.startsWith("blake3") ? 16 : 32;
  const make = async (): Promise<Hasher> => {
    switch (name) {
      case "blake3-wasm":
        return createWasmHasher(modules.blake3, "blake3");
      case "sha1-wasm":
        return createWasmHasher(modules.sha1, "sha1");
      case "sha256-wasm":
        return createWasmHasher(modules.sha256, "sha256");
      case "blake3-noble":
        return createBlake3();
      case "sha1-noble":
        return createSha1("noble");
      case "sha256-noble":
        return createSha256();
      default:
        throw new Error(`unknown bench ${name}`);
    }
  };
  const h = await make();
  const t = performance.now();
  for (let i = 0; i < mib * 16; i++) h.update(BENCH_BUF);
  h.digest();
  return { name, amount: (mib * 1048576) / 1e6, unit: "MB", ms: performance.now() - t };
}
