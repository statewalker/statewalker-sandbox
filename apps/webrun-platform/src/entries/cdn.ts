// The ESM CDN app alone (with user code as ESM, the notebooks and the package store): only
// lightningcss.wasm, no esbuild. For hosts whose script size limit (Cloudflare: 10 MB
// compressed) the composed platform's two WebAssembly modules exceed.
import lightningCssWasm from "lightningcss-wasm/lightningcss_node.wasm";
import { provideWasm } from "../core/wasm.js";
import { createHandler, type PlatformEnv } from "../platform.js";

provideWasm({ lightningcss: lightningCssWasm });
const handle = createHandler(["registry", "cdn", "projects", "notebooks"]);

export { ModuleHost, NotebookSite, PackageRegistry, Project } from "../platform.js";
export default {
  fetch: (request: Request, env: PlatformEnv, ctx: ExecutionContext) => handle(request, env, ctx),
};
