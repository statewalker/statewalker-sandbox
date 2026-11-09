// Entry of the composed platform for Wrangler (workerd) and celld: the WebAssembly comes in as
// modules. scripts/build-cellb.mjs builds the same entry for cellb.
import esbuildWasm from "esbuild-wasm/esbuild.wasm";
import lightningCssWasm from "lightningcss-wasm/lightningcss_node.wasm";
import { provideWasm } from "../core/wasm.js";
import { handlePlatform, type PlatformEnv } from "../platform.js";

provideWasm({ esbuild: esbuildWasm, lightningcss: lightningCssWasm });

export * from "../platform.js";
export default {
  fetch: (request: Request, env: PlatformEnv, ctx: ExecutionContext) =>
    handlePlatform(request, env, ctx),
};
