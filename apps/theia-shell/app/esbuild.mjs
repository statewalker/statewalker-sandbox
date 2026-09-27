/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun theia build again.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import { browserOptions, watch } from "./gen-esbuild.browser.mjs";

// The mesh edge's ServiceWorker must sit un-hashed at the origin root (see
// `@theia-shell/theia-httpeers`'s `scripts/copy-sw.mjs`).
const require = createRequire(import.meta.url);
mkdirSync("lib/frontend", { recursive: true });
copyFileSync(require.resolve("@theia-shell/theia-httpeers/lib/sw.js"), "lib/frontend/sw.js");

/**
 * Theia bundles the frontend as a classic script, where `import.meta` is an
 * empty object. `@statewalker/webrun-http-browser` 0.6 resolves its worker
 * scope with `new URL(scope, import.meta.url)`, which then throws `Invalid
 * URL` and the mesh edge never starts. Its modules are given the page's own
 * URL instead, which is what the scope must be on anyway (a ServiceWorker is
 * same-origin). Fixed upstream in webrun-wire (`SwPortHandler.rootUrl`
 * resolves against the worker's URL); this goes once a release has it.
 */
const importMetaUrlForWebrun = {
  name: "import-meta-url-for-webrun-http-browser",
  setup(build) {
    build.onLoad({ filter: /webrun-http-browser[\\/]dist[\\/].*\.js$/ }, async (args) => ({
      contents: (await readFile(args.path, "utf8")).replaceAll(
        "import.meta.url",
        "self.location.href",
      ),
      loader: "js",
    }));
  },
};
browserOptions.plugins.unshift(importMetaUrlForWebrun);

const browserContext = await esbuild.context(browserOptions);

if (watch) {
  await browserContext.watch();
} else {
  try {
    await browserContext.rebuild();
    await browserContext.dispose();
  } catch {
    process.exit(1);
  }
}
