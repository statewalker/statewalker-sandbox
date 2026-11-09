/**
 * workerd-only native streaming hashes: `crypto.DigestStream` (SHA-1, SHA-256). Browsers have no
 * streaming equivalent (WebCrypto `subtle.digest` is one-shot), so this tier exists only in
 * workerd. Pointed out by the review of #52; measured here rather than assumed.
 */

import { toHex } from "../../03-sha256-blake3/src/hashes.js";
import type { BenchRow, Check, Fixtures } from "../../05-runtime-matrix/src/types.js";
import { base64ToBytes } from "./wasm-hasher.js";

export const WORKERD_NATIVE_BENCH_NAMES = ["sha1-digeststream", "sha256-digeststream"] as const;

interface DigestStreamLike extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
}
type DigestStreamCtor = new (algorithm: "SHA-1" | "SHA-256") => DigestStreamLike;

function digestStream(): DigestStreamCtor {
  const ctor = (globalThis.crypto as unknown as { DigestStream?: DigestStreamCtor }).DigestStream;
  if (!ctor) throw new Error("crypto.DigestStream is not available in this runtime");
  return ctor;
}

async function hashParts(
  algorithm: "SHA-1" | "SHA-256",
  parts: Iterable<Uint8Array>,
): Promise<string> {
  const DigestStream = digestStream();
  const ds = new DigestStream(algorithm);
  const writer = ds.getWriter();
  for (const p of parts) await writer.write(p);
  await writer.close();
  return toHex(new Uint8Array(await ds.digest));
}
function* chunked(bytes: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let pos = 0; pos < bytes.length; pos += size) yield bytes.subarray(pos, pos + size);
}

export async function runDigestStreamConformance(fx: Fixtures): Promise<Check[]> {
  const checks: Check[] = [];
  const enc = new TextEncoder();
  for (const o of fx.gitObjects) {
    const name = `digeststream:sha1:git:${o.name}`;
    try {
      const bytes = base64ToBytes(o.b64);
      const id = await hashParts("SHA-1", [
        enc.encode(`${o.type} ${bytes.length}\0`),
        ...chunked(bytes, 4096),
      ]);
      checks.push(id === o.id ? { name, ok: true } : { name, ok: false, detail: `got ${id}` });
    } catch (e) {
      checks.push({ name, ok: false, detail: String(e) });
    }
  }
  for (const s of fx.sha256) {
    const name = `digeststream:sha256:${s.name}`;
    try {
      const hex = await hashParts("SHA-256", chunked(base64ToBytes(s.b64), 65536));
      checks.push(hex === s.hex ? { name, ok: true } : { name, ok: false, detail: `got ${hex}` });
    } catch (e) {
      checks.push({ name, ok: false, detail: String(e) });
    }
  }
  return checks;
}

const BENCH_BUF = Uint8Array.from({ length: 65536 }, (_, i) => (i * 31 + 7) & 0xff);

export async function runDigestStreamBench(name: string): Promise<BenchRow> {
  const algorithm =
    name === "sha1-digeststream" ? "SHA-1" : name === "sha256-digeststream" ? "SHA-256" : undefined;
  if (!algorithm) throw new Error(`unknown bench ${name}`);
  const mib = 128;
  const t = performance.now();
  await hashParts(
    algorithm,
    (function* () {
      for (let i = 0; i < mib * 16; i++) yield BENCH_BUF;
    })(),
  );
  return { name, amount: (mib * 1048576) / 1e6, unit: "MB", ms: performance.now() - t };
}
