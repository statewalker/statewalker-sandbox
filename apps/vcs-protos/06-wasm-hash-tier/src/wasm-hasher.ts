/**
 * X1e — portable wrapper over hash-wasm's binaries that takes an already compiled
 * WebAssembly.Module, so the caller decides how it was obtained: compiled from bytes (Node,
 * browsers) or imported precompiled (workerd, which refuses runtime compilation).
 *
 * ABI (from hash-wasm 4.13.0, lib/WASMInterface.ts): input and output share a 16 KiB transfer
 * buffer at `Hash_GetBuffer()`; `Hash_Init(param)` (BLAKE3: 0, or 32 with the key already in the
 * buffer; SHA-256: 256; SHA-1: 0), `Hash_Update(len)` per ≤16 KiB chunk, `Hash_Final(param)`
 * (BLAKE3: output length), digest read back from the buffer.
 */

export type WasmAlgo = "blake3" | "sha1" | "sha256";
export interface Hasher {
  update(bytes: Uint8Array): Hasher;
  digest(): Uint8Array;
}
export interface WasmHashOptions {
  /** BLAKE3 keyed_hash mode: exactly 32 bytes. */
  key?: Uint8Array;
  /** BLAKE3 derive_key mode: not built into these binaries — rejected. */
  context?: Uint8Array;
  /** BLAKE3 output length in bytes (default 32). */
  dkLen?: number;
}
export type WasmModules = Record<WasmAlgo, WebAssembly.Module>;

const MAX_HEAP = 16 * 1024;

interface HashExports {
  memory: WebAssembly.Memory;
  Hash_GetBuffer(): number;
  Hash_Init(param: number): void;
  Hash_Update(length: number): void;
  Hash_Final(param: number): void;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One instance per hasher: the binaries hold a single hash state each. */
export async function createWasmHasher(
  module: WebAssembly.Module,
  algo: WasmAlgo,
  opts: WasmHashOptions = {},
): Promise<Hasher> {
  if (opts.context) {
    throw new Error("BLAKE3 derive_key mode is not built into the hash-wasm binaries");
  }
  if (algo !== "blake3" && (opts.key !== undefined || opts.dkLen !== undefined)) {
    throw new Error(`${algo}: key and dkLen apply to BLAKE3 only`);
  }
  if (opts.key && opts.key.length !== 32) {
    throw new Error(`BLAKE3 key must be exactly 32 bytes, got ${opts.key.length}`);
  }
  const outLen = algo === "blake3" ? (opts.dkLen ?? 32) : algo === "sha1" ? 20 : 32;
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > MAX_HEAP) {
    throw new Error(`output length must be 1..${MAX_HEAP} bytes`);
  }

  const instance = await WebAssembly.instantiate(module, {});
  const ex = instance.exports as unknown as HashExports;
  const offset = ex.Hash_GetBuffer();
  // Re-created on each use: a memory.grow would detach a cached view.
  const buffer = () => new Uint8Array(ex.memory.buffer, offset, MAX_HEAP);

  if (opts.key) buffer().set(opts.key);
  ex.Hash_Init(algo === "blake3" ? (opts.key ? 32 : 0) : algo === "sha256" ? 256 : 0);

  let done = false;
  const self: Hasher = {
    update(bytes) {
      if (done) throw new Error("hasher already finalized");
      for (let pos = 0; pos < bytes.length; pos += MAX_HEAP) {
        const chunk = bytes.subarray(pos, pos + MAX_HEAP);
        buffer().set(chunk);
        ex.Hash_Update(chunk.length);
      }
      return self;
    },
    digest() {
      if (done) throw new Error("hasher already finalized");
      done = true;
      ex.Hash_Final(algo === "blake3" ? outLen : 0);
      return buffer().slice(0, outLen);
    },
  };
  return self;
}
