/**
 * The wasm LOADER SEAM, as a module that can stand in for
 * `@biscuit-auth/biscuit-wasm` under a bundler alias.
 *
 * WHY ONE IS NEEDED AT ALL. The published package is a `wasm-pack --target
 * bundler` build and its only entry point does this:
 *
 *     import * as wasm from "./biscuit_bg.wasm";
 *     export * from "./biscuit_bg.js";
 *     import { __wbg_set_wasm } from "./biscuit_bg.js";
 *     __wbg_set_wasm(wasm);
 *     wasm.__wbindgen_start();
 *
 * A bundler turns that first line into a fetch-and-instantiate behind a
 * TOP-LEVEL AWAIT. Pages allow top-level await; **module ServiceWorkers do
 * not**, so the ordinary import cannot be used inside a worker.
 *
 * `biscuit_bg.js` exporting `__wbg_set_wasm` is what makes another route
 * possible: instantiate the module by hand, from bytes, and hand the exports
 * in. No top-level await, so the worker's module graph stays legal and the
 * init happens inside an async function instead.
 *
 * THE DEEP IMPORT IS THE CATCH, and it is a real constraint on the library
 * rather than a detail of this rung. The package's `exports` map is
 * `{ "import": "./module/biscuit.js" }` with no wildcard, so
 * `@biscuit-auth/biscuit-wasm/module/biscuit_bg.js` is NOT resolvable by any
 * strict ESM resolver. This file reaches it by filesystem path, which a
 * prototype may do and a published package may not: shipping this would mean
 * a documented bundler alias, a vendored copy, or an upstream change.
 */

// biome-ignore lint/style/useNodejsImportProtocol: resolved by the bundler as a file path, not by Node.
import * as bg from "../../node_modules/@biscuit-auth/biscuit-wasm/module/biscuit_bg.js";

export * from "../../node_modules/@biscuit-auth/biscuit-wasm/module/biscuit_bg.js";

/**
 * THE WASM NEEDS MORE THAN THE BINDING MODULE. Its import section names
 * `./biscuit_bg.js` *and* seven `./snippets/biscuit-auth-<hash>/inline0.js`
 * modules — wasm-bindgen's `#[wasm_bindgen(inline_js = ...)]` outputs.
 * Supplying only the first produces:
 *
 *     TypeError: WebAssembly.instantiate(): Import #17
 *     "./snippets/biscuit-auth-314ca57174ae0e6d/inline0.js":
 *     module is not an object or function
 *
 * The directory names are content hashes and would change on any upstream
 * rebuild, so they are gathered by glob rather than written out.
 */
const SNIPPETS = import.meta.glob(
  "../../node_modules/@biscuit-auth/biscuit-wasm/module/snippets/*/inline0.js",
  { eager: true },
) as Record<string, unknown>;

/** Re-key the glob's file paths as the specifiers the wasm's import section uses. */
function snippetImports(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, module] of Object.entries(SNIPPETS)) {
    const at = path.indexOf("snippets/");
    if (at >= 0) out[`./${path.slice(at)}`] = module;
  }
  return out;
}

let started: Promise<void> | null = null;

/**
 * Instantiate the Biscuit wasm from `wasmUrl` and arm the binding shim.
 * Idempotent: the first call wins and later ones await the same promise.
 */
export async function initBiscuit(wasmUrl: string): Promise<void> {
  if (started != null) return started;
  started = (async (): Promise<void> => {
    const response = await fetch(wasmUrl);
    // The import object wasm-bindgen's bundler output expects: the binding
    // module itself, under the specifier the .wasm names it by.
    const imports = {
      "./biscuit_bg.js": bg,
      ...snippetImports(),
    } as unknown as WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
    const exports = instance.exports as Record<string, unknown> & { __wbindgen_start?: () => void };
    (bg as unknown as { __wbg_set_wasm(value: unknown): void }).__wbg_set_wasm(exports);
    exports.__wbindgen_start?.();
  })();
  return started;
}
