/** Node and browsers: compile the binaries from their base64 copies (forbidden in workerd). */

import { BLAKE3_WASM_B64, SHA1_WASM_B64, SHA256_WASM_B64 } from "./wasm/binaries.js";
import type { WasmModules } from "./wasm-hasher.js";
import { base64ToBytes } from "./wasm-hasher.js";

export async function compileModulesFromBytes(): Promise<WasmModules> {
  const compile = (b64: string) =>
    WebAssembly.compile(base64ToBytes(b64) as Uint8Array<ArrayBuffer>);
  const [blake3, sha1, sha256] = await Promise.all([
    compile(BLAKE3_WASM_B64),
    compile(SHA1_WASM_B64),
    compile(SHA256_WASM_B64),
  ]);
  return { blake3, sha1, sha256 };
}
