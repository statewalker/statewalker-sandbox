/**
 * workerd refuses to compile WebAssembly from bytes at runtime
 * (`WebAssembly.compile`, `instantiate(buffer)`): wasm has to arrive as a
 * module of the Worker (a `.wasm` import is a compiled `WebAssembly.Module`)
 * or of a Worker Loader isolate (`{ wasm: bytes }`).
 *
 * tesseract-wasm's Emscripten glue only knows `WebAssembly.instantiate(bytes,
 * imports)`. While `fn` runs, that call is answered from the precompiled
 * module instead, so the library works unmodified. The linear memory the
 * instance exports is recorded, to report how much memory OCR takes.
 */

export type WasmProbe = { memory?: WebAssembly.Memory };

export async function withPrecompiledWasm<T>(
  module: WebAssembly.Module,
  probe: WasmProbe,
  fn: () => Promise<T>,
): Promise<T> {
  const original = WebAssembly.instantiate;
  const patched = (async (source: unknown, imports?: WebAssembly.Imports) => {
    if (source instanceof WebAssembly.Module) return original(source, imports);
    // Bytes (the library's `wasmBinary`): instantiate the precompiled module instead,
    // shaped like instantiate(bytes)'s result.
    const instance = await original(module, imports);
    for (const value of Object.values(instance.exports)) {
      if (value instanceof WebAssembly.Memory) probe.memory = value;
    }
    return { module, instance };
  }) as typeof WebAssembly.instantiate;
  WebAssembly.instantiate = patched;
  try {
    return await fn();
  } finally {
    WebAssembly.instantiate = original;
  }
}
