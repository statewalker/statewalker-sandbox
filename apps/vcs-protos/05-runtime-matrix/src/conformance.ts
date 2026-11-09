/**
 * X0a — one portable conformance run over the X1 modules, identical in Node, a browser page, a
 * Dedicated Worker and workerd. Fixtures come in as JSON (base64 bytes); nothing here imports
 * from `node:` — R5 bundles this file for platform "browser" to prove it.
 */
import { deflate } from "pako";
import { createSha1, hashGitObject } from "../../01-streaming-git-hash/src/git-object-hash.js";
import { walkPack } from "../../02-inflate-stream-ends/src/pack-walk.js";
import { inflateSequence } from "../../02-inflate-stream-ends/src/stream-inflater.js";
import {
  createBlake3,
  createSha256,
  lfsPointer,
  toHex,
} from "../../03-sha256-blake3/src/hashes.js";
import {
  createInflaterPool,
  type InflaterPool,
} from "../../04-pooled-inflater/src/pooled-inflater.js";
import type { BenchRow, Check, Fixtures } from "./types.js";

export const BENCH_NAMES = [
  "sha1-noble",
  "sha256-noble",
  "blake3-noble",
  "inflate-pooled",
] as const;

const SHA1_IMPLS = ["vcs", "noble"] as const;
const BLAKE3_MODES = ["hash", "keyed_hash", "derive_key"] as const;
const INFLATE_CHUNKS = [1, 7, 4096] as const;
const PACK_CHUNKS = [1, 65536] as const;

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function* chunked(bytes: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let pos = 0; pos < bytes.length; pos += size) yield bytes.subarray(pos, pos + size);
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const vectorInput = (len: number) => Uint8Array.from({ length: len }, (_, i) => i % 251);

/** The stable, ordered list of check names a given fixture set produces. */
export function expectedCheckNames(fx: Fixtures): string[] {
  return [
    ...fx.gitObjects.flatMap((o) => SHA1_IMPLS.map((impl) => `git:${o.name}:${impl}`)),
    ...fx.blake3.cases.flatMap((c) => BLAKE3_MODES.map((m) => `blake3:${m}:${c.input_len}`)),
    ...fx.sha256.map((s) => `sha256:${s.name}`),
    ...fx.lfs.map((l) => `lfs:${l.name}`),
    ...INFLATE_CHUNKS.map((c) => `inflate:push:chunk${c}`),
    ...INFLATE_CHUNKS.map((c) => `inflate:pooled:chunk${c}`),
    ...fx.packs.flatMap((p) => PACK_CHUNKS.map((c) => `pack:${p.kind}:chunk${c}`)),
  ];
}

/** Inflate `count` consecutive streams through a pool, the way a pack reader would. */
function inflatePooled(pool: InflaterPool, chunks: Iterable<Uint8Array>, count: number) {
  const results: Array<{ data: Uint8Array; compressedLength: number }> = [];
  let inf: ReturnType<InflaterPool["acquire"]> | undefined;
  let out: Uint8Array[] = [];
  let consumed = 0;
  for (let chunk of chunks) {
    while (chunk.length > 0 && results.length < count) {
      inf ??= pool.acquire();
      const r = inf.push(chunk);
      out.push(...r.out);
      consumed += r.consumed;
      chunk = chunk.subarray(r.consumed);
      if (r.done) {
        inf.end();
        results.push({ data: concat(out), compressedLength: consumed });
        inf = undefined;
        out = [];
        consumed = 0;
      }
    }
  }
  return results;
}

export async function runConformance(fx: Fixtures): Promise<Check[]> {
  const checks: Check[] = [];
  const check = async (
    name: string,
    fn: () => Promise<string | undefined> | string | undefined,
  ) => {
    try {
      const problem = await fn();
      checks.push(problem ? { name, ok: false, detail: problem } : { name, ok: true });
    } catch (e) {
      checks.push({ name, ok: false, detail: `threw: ${String(e)}` });
    }
  };

  for (const o of fx.gitObjects) {
    const bytes = fromB64(o.b64);
    for (const impl of SHA1_IMPLS) {
      await check(`git:${o.name}:${impl}`, async () => {
        const id = await hashGitObject(o.type, bytes.length, chunked(bytes, 4096), () =>
          createSha1(impl),
        );
        return id === o.id ? undefined : `got ${id}, git says ${o.id}`;
      });
    }
  }

  const enc = new TextEncoder();
  const key = enc.encode(fx.blake3.key);
  const context = enc.encode(fx.blake3.context);
  for (const c of fx.blake3.cases) {
    const input = vectorInput(c.input_len);
    for (const mode of BLAKE3_MODES) {
      await check(`blake3:${mode}:${c.input_len}`, () => {
        const opts = mode === "keyed_hash" ? { key } : mode === "derive_key" ? { context } : {};
        const h = createBlake3({ ...opts, dkLen: c[mode].length / 2 });
        for (const part of chunked(input, 1000)) h.update(part);
        const got = toHex(h.digest());
        return got === c[mode] ? undefined : `mismatch at input_len ${c.input_len}`;
      });
    }
  }

  for (const s of fx.sha256) {
    await check(`sha256:${s.name}`, () => {
      const h = createSha256();
      for (const part of chunked(fromB64(s.b64), 65536)) h.update(part);
      const got = toHex(h.digest());
      return got === s.hex ? undefined : `got ${got}`;
    });
  }
  for (const l of fx.lfs) {
    await check(`lfs:${l.name}`, async () => {
      const got = await lfsPointer(chunked(fromB64(l.b64), 65536));
      return got === l.pointer ? undefined : `pointer differs from ${l.oracle}`;
    });
  }

  const zAll = fromB64(fx.zlib.concatenatedB64);
  const zInputs = fx.zlib.inputs.map(fromB64);
  const compare = (results: Array<{ data: Uint8Array; compressedLength: number }>) => {
    if (results.length !== zInputs.length) return `got ${results.length} streams`;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || r.compressedLength !== fx.zlib.lengths[i])
        return `stream ${i}: wrong compressed length`;
      if (!sameBytes(r.data, zInputs[i] ?? new Uint8Array())) return `stream ${i}: wrong data`;
    }
    return undefined;
  };
  for (const size of INFLATE_CHUNKS) {
    await check(`inflate:push:chunk${size}`, async () => {
      const results: Array<{ data: Uint8Array; compressedLength: number }> = [];
      for await (const r of inflateSequence(chunked(zAll, size), zInputs.length)) results.push(r);
      return compare(results);
    });
  }
  for (const size of INFLATE_CHUNKS) {
    await check(`inflate:pooled:chunk${size}`, () =>
      compare(inflatePooled(createInflaterPool(), chunked(zAll, size), zInputs.length)),
    );
  }

  for (const p of fx.packs) {
    const pack = fromB64(p.b64);
    for (const size of PACK_CHUNKS) {
      await check(`pack:${p.kind}:chunk${size}`, async () => {
        const walk = await walkPack(chunked(pack, size));
        if (walk.count !== p.count) return `count ${walk.count} vs ${p.count}`;
        const offsets = walk.entries.map((e) => e.offset);
        if (offsets.join() !== p.offsets.join()) return "offsets differ from git verify-pack";
        if (!walk.trailerOk) return "trailer SHA-1 mismatch";
        if (walk.entries.some((e) => e.inflatedLength !== e.size)) return "inflated length != size";
        const deltaType = p.kind === "ofs" ? 6 : 7;
        if (!walk.entries.some((e) => e.type === deltaType)) return `no type-${deltaType} entries`;
        return undefined;
      });
    }
  }
  return checks;
}

let smallObjects: Uint8Array[] | undefined;

/** One named benchmark; timed with performance.now() (meaningless in workerd: time it from outside). */
export async function runBench(name: string): Promise<BenchRow> {
  const buf = Uint8Array.from({ length: 65536 }, (_, i) => (i * 31 + 7) & 0xff);
  const stream = (
    mib: number,
    make: () => { update(b: Uint8Array): unknown; digest(): Uint8Array },
  ) => {
    const t = performance.now();
    const h = make();
    for (let i = 0; i < mib * 16; i++) h.update(buf);
    h.digest();
    return { amount: (mib * 1048576) / 1e6, unit: "MB" as const, ms: performance.now() - t };
  };
  switch (name) {
    case "sha1-noble":
      return { name, ...stream(32, () => createSha1("noble")) };
    case "sha256-noble":
      return { name, ...stream(32, () => createSha256()) };
    case "blake3-noble":
      return { name, ...stream(8, () => createBlake3()) };
    case "inflate-pooled": {
      const enc = new TextEncoder();
      smallObjects ??= Array.from({ length: 5000 }, (_, i) =>
        deflate(enc.encode(`tree entry ${i} `.repeat(15))),
      );
      const pool = createInflaterPool();
      const t = performance.now();
      for (const z of smallObjects) {
        const inf = pool.acquire();
        inf.push(z);
        inf.end();
      }
      return { name, amount: smallObjects.length, unit: "objects", ms: performance.now() - t };
    }
    default:
      throw new Error(`unknown bench ${name}`);
  }
}
