// Prepares the plugins in late-plugins-src/ exactly as `theia build` prepares
// plugins-src/, but keeps their metadata OUT of hostedPlugin/list.json. Their
// files go next to the static ones, so they are reachable by URL; their
// metadata goes to lib/frontend/late-plugins.json, which the page reads and
// deploys at runtime. It stands in for an installer that fetched a package.
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBrowserOnlyPlugins } from "@theia/application-manager/lib/browser-only/prepare-browser-only-plugins.js";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const out = await mkdtemp(join(tmpdir(), "late-plugins-"));
await prepareBrowserOnlyPlugins({
  projectPath: appDir,
  pck: { theiaPluginsDir: "late-plugins-src" },
  lib: (...segments) => join(out, ...segments),
});
const prepared = join(out, "frontend", "hostedPlugin");
for (const name of await readdir(prepared)) {
  if (name === "list.json") continue;
  await cp(join(prepared, name), join(appDir, "lib/frontend/hostedPlugin", name), {
    recursive: true,
  });
}
await writeFile(
  join(appDir, "lib/frontend/late-plugins.json"),
  await readFile(join(prepared, "list.json")),
);
await rm(out, { recursive: true });
