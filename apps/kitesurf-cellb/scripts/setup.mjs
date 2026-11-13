// Prepares the host for a built Kitesurf checkout:
//   node scripts/setup.mjs [kitesurf-dir]     (default: $KITESURF or ../../../kitesurf)
//
// - engine/wrangler.json: Kitesurf's engine config with absolute `main` and assets paths, plus
//   `nodejs_compat` (Kitesurf reads its wasm with `node:fs`; with nodejs_compat CellB on Node gives
//   Worker code the real `node:fs`).
// - /bundle/*.wasm: workerd exposes a Worker's modules under /bundle, and Kitesurf reads its two
//   wasm files from there. They are linked from the checkout.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ks = resolve(process.argv[2] ?? process.env.KITESURF ?? join(app, "../../../kitesurf"));
const wasm = {
  "kitesurf_core_bg.wasm": join(ks, "packages/core/pkg/kitesurf_core_bg.wasm"),
  "renderer_core_bg.wasm": join(ks, "packages/renderer-core/pkg/renderer_core_bg.wasm"),
};
for (const file of Object.values(wasm)) {
  if (!existsSync(file)) {
    console.error(
      `setup: ${file} is missing. Build Kitesurf first: bazel run //packages/engine:dev_build`,
    );
    process.exit(1);
  }
}

// JSONC: strip comments outside strings, then trailing commas.
const jsonc = (s) =>
  JSON.parse(
    s
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1"),
  );
const config = jsonc(readFileSync(join(ks, "packages/engine/wrangler.jsonc"), "utf8"));
delete config.env;
delete config.$schema;
delete config.observability;
// Paths in the config are relative to the engine's folder; this config lives elsewhere.
const engineDir = join(ks, "packages/engine");
config.main = resolve(engineDir, config.main);
if (config.assets?.directory) config.assets.directory = resolve(engineDir, config.assets.directory);
config.compatibility_flags = [...new Set([...(config.compatibility_flags ?? []), "nodejs_compat"])];
mkdirSync(join(app, "engine"), { recursive: true });
writeFileSync(join(app, "engine/wrangler.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`setup: wrote engine/wrangler.json (Kitesurf at ${ks})`);

try {
  mkdirSync("/bundle", { recursive: true });
  for (const [name, file] of Object.entries(wasm)) {
    rmSync(join("/bundle", name), { force: true });
    symlinkSync(file, join("/bundle", name));
  }
  console.log("setup: linked /bundle/kitesurf_core_bg.wasm and /bundle/renderer_core_bg.wasm");
} catch (e) {
  console.error(`setup: cannot write /bundle (${e.code ?? e.message}). Create it once with:
  sudo mkdir -p /bundle && sudo ln -sf ${wasm["kitesurf_core_bg.wasm"]} ${wasm["renderer_core_bg.wasm"]} /bundle/`);
  process.exit(1);
}
