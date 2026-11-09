/** X1e — portable wrapper over hash-wasm binaries, taking a compiled WebAssembly.Module. STUB (red phase). */

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

export function base64ToBytes(_b64: string): Uint8Array {
  throw new Error("not implemented");
}

export async function createWasmHasher(
  _module: WebAssembly.Module,
  _algo: WasmAlgo,
  _opts?: WasmHashOptions,
): Promise<Hasher> {
  throw new Error("not implemented");
}
