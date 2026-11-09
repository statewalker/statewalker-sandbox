// Tool bundling (webrun-bundler + inline shims) and the acceptance check, in plain Node:
// `cloudflare:workers` is supplied as a stub module, the capability is a fake over a Map.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as esbuild from "esbuild";
import { bundleTool } from "../../src/tools/bundle.ts";
import { checkToolBundle } from "../../src/tools/check.ts";
import { toolConfig } from "../../src/tools/config.ts";

const RUN_IN_NODE = {
  external: [],
  modules: { "cloudflare:workers": "export class WorkerEntrypoint {}" },
};

/** A capability like ToolFiles: call/readdir/move, EACCES outside `/allowed`. */
function fakeFiles(initial = {}) {
  const data = new Map(Object.entries(initial));
  const guard = (p) => {
    if (!p.startsWith("/allowed")) throw new Error(`EACCES: permission denied, '${p}'`);
  };
  return {
    data,
    async call(method, p, ...a) {
      guard(p);
      if (method === "readFile") {
        if (!data.has(p)) throw new Error(`ENOENT: no such file '${p}'`);
        return data.get(p);
      }
      if (method === "writeFile") return void data.set(p, a[0]);
      if (method === "appendFile") return void data.set(p, (data.get(p) ?? "") + a[0]);
      if (method === "exists") return data.has(p);
      if (method === "stat")
        return { isFile: data.has(p), isDirectory: !data.has(p), size: 0, mode: 0, mtime: 0 };
      if (method === "mkdir" || method === "rm") return;
      throw new Error(`ENOSYS: ${method}`);
    },
    async readdir(p) {
      guard(p);
      return [...data.keys()]
        .filter((k) => k.startsWith(`${p}/`))
        .map((k) => k.slice(p.length + 1));
    },
    async move(kind, s, d) {
      guard(s);
      guard(d);
      data.set(d, data.get(s));
      if (kind === "mv") data.delete(s);
    },
  };
}
const load = async (code) =>
  (
    await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${Math.random()}`
    )
  ).default;

const TOOL = `
import { readFile, writeFile } from "node:fs/promises";
import fs from "fs";
import * as path from "node:path";
import os from "node:os";
export async function run(input: { dir: string }) {
  const text = await readFile(path.join(input.dir, "in.txt"), "utf8");
  await writeFile(path.join(input.dir, "out.txt"), text.toUpperCase());
  const viaCallback = await new Promise((ok, ko) => fs.readFile(input.dir + "/out.txt", "utf8", (e, v) => (e ? ko(e) : ok(v))));
  let denied = "";
  try { await readFile("/secret/key", "utf8"); } catch (e: any) { denied = e.code; }
  let sync = "";
  try { fs.readFileSync(input.dir + "/in.txt"); } catch (e: any) { sync = e.code; }
  let osUse = "";
  try { os.homedir(); } catch (e: any) { osUse = e.message; }
  return { viaCallback, denied, sync, osUse, same: fs.readFile === readFile, ext: path.extname("a/b.md") };
}`;

test("node:fs, fs, fs/promises and node:path are rewritten; other builtins denied", async () => {
  const out = await bundleTool({
    esbuild,
    sources: { "/index.ts": TOOL },
    entry: "/index.ts",
    config: RUN_IN_NODE,
  });
  assert.equal(out.check.ok, true, out.check.problems.join("; "));
  assert.doesNotMatch(out.code, /from\s*["']node:/, "no Node builtin import is left");
  const files = fakeFiles({ "/allowed/in.txt": "hello" });
  const Tool = await load(out.code);
  const r = await new Tool().run(files, { dir: "/allowed" });
  assert.deepEqual(r, {
    viaCallback: "HELLO",
    denied: "EACCES",
    sync: "ENOSYS",
    osUse: "ENOSYS: node:os is not available to tools",
    same: true,
    ext: ".md",
  });
  assert.equal(files.data.get("/allowed/out.txt"), "HELLO");
});

test("the bundling is configurable", async () => {
  // fs under another name, path left to a module of our own, builtins left external
  const tool = `import { readFile } from "my-fs"; import path from "node:path";
export default async (input: any) => (await readFile("/allowed/in.txt", "utf8")) + path.sep;`;
  const out = await bundleTool({
    esbuild,
    sources: { "/t.ts": tool },
    entry: "/t.ts",
    config: {
      ...RUN_IN_NODE,
      fsModules: ["my-fs"],
      pathModules: [],
      modules: { ...RUN_IN_NODE.modules, "node:path": "export default { sep: '|' };" },
    },
  });
  assert.equal(out.check.ok, true, out.check.problems.join("; "));
  const Tool = await load(out.code);
  assert.equal(await new Tool().run(fakeFiles({ "/allowed/in.txt": "x" }), {}), "x|");

  const ext = await bundleTool({
    esbuild,
    sources: {
      "/t.ts": `import { hostname } from "node:os"; export const run = () => hostname();`,
    },
    entry: "/t.ts",
    config: { ...RUN_IN_NODE, builtins: "external" },
  });
  assert.equal(ext.check.ok, false, "a builtin left external is rejected by the check");
  assert.match(ext.check.problems.join(), /import of 'node:os'/);
});

test("the acceptance check rejects what bundling should have removed", () => {
  const config = toolConfig();
  const bad = {
    raw: `import fs from "node:fs"; export default fs;`,
    dynamic: `export const f = () => import("node:" + "fs");`,
    meta: `export const u = import.meta.url;`,
    process: `export const e = () => process.env;`,
    globalProcess: `export const e = () => globalThis.process;`,
    computedGlobal: `export const e = (k) => globalThis[k];`,
    eval: `export const e = (s) => eval(s);`,
    fn: `export const e = (s) => new Function(s);`,
    require: `export const r = require("fs");`,
    reexport: `export * from "node:child_process";`,
  };
  for (const [name, code] of Object.entries(bad)) {
    assert.equal(checkToolBundle(code, config).ok, false, `${name} must be rejected`);
  }
  const good = `import { WorkerEntrypoint } from "cloudflare:workers";
const o = { process: 1, eval: 2 }; o.require = 3;
export default class extends WorkerEntrypoint { run() { return o.process + o.eval; } }`;
  assert.deepEqual(checkToolBundle(good, config), { ok: true, problems: [] });
  assert.equal(checkToolBundle("not js {", config).ok, false);
});

test("known limit: computed access on ordinary objects passes the check", () => {
  // Why hostFsRuntimes defaults to "refuse": the check is not a sandbox.
  const sneaky = `export const f = () => ({}).constructor.constructor("return 1")();`;
  assert.equal(checkToolBundle(sneaky, toolConfig()).ok, true);
});

test("defaults ← overrides", () => {
  const c = toolConfig({ hostFsRuntimes: "bundled-only", check: { forbidImportMeta: false } });
  assert.equal(c.hostFsRuntimes, "bundled-only");
  assert.equal(c.check.forbidImportMeta, false);
  assert.equal(c.check.forbidDynamicImport, true, "other check keys keep their defaults");
  assert.deepEqual(toolConfig().fsModules, ["node:fs", "fs", "node:fs/promises", "fs/promises"]);
});
