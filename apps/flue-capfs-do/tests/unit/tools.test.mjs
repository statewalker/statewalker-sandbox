// Tool bundling (webrun-bundler + inline shims) and the acceptance check, in plain Node:
// `cloudflare:workers` is supplied as a stub module, the capability is a fake over a Map.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as esbuild from "esbuild";
import { bundleTool } from "../../src/tools/bundle.ts";
import { bundleHash, checkToolBundle, matchesPattern } from "../../src/tools/check.ts";
import { toolConfig } from "../../src/tools/config.ts";
import { admitTool, toolPolicy } from "../../src/tools/policy.ts";

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
      // Text is kept as a string, bytes as a Uint8Array (as the store keeps them in its BLOB).
      if (method === "readFileBuffer") {
        if (!data.has(p)) throw new Error(`ENOENT: no such file '${p}'`);
        const v = data.get(p);
        return typeof v === "string" ? new TextEncoder().encode(v) : v.slice();
      }
      if (method === "writeFileBuffer") return void data.set(p, new Uint8Array(a[0]));
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
  return { viaCallback, denied, sync, osUse, same: fs.promises.readFile === readFile, ext: path.extname("a/b.md") };
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

test("known limit: function constructors pass the check (why host-fs runtimes need approved bundles)", () => {
  // The check is not a sandbox; admitTool requires allowedBundles where it would matter.
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

// ---- regressions from the PR #46 review ----

const build = (src, config = {}) =>
  bundleTool({
    esbuild,
    sources: { "/index.ts": src },
    entry: "/index.ts",
    config: { ...RUN_IN_NODE, ...config },
  });
const runTool = async (out, files = fakeFiles(), input = {}) =>
  new (await load(out.code))().run(files, input);

test("the check rejects aliasing the global object and allows locals named like globals", () => {
  const config = toolConfig();
  for (const code of [
    "const { process: p } = globalThis; export const f = () => p;",
    "const g = globalThis; export const f = () => g.process;",
    "export const f = () => Reflect.get(globalThis, 'process');",
    "export const f = () => Object.getOwnPropertyDescriptor(globalThis, 'process');",
    "export const f = () => [self][0];",
    "export const f = () => (0, globalThis).process;",
  ]) {
    assert.equal(checkToolBundle(code, config).ok, false, code);
  }
  for (const code of [
    "export const f = (process) => process.env;", // a CommonJS-style parameter
    "var global = 1; export const f = () => global;",
    "export const f = () => globalThis.queueMicrotask;",
    "function require(x) { return x; } export const r = require('a');",
  ]) {
    assert.deepEqual(checkToolBundle(code, config).problems, [], code);
  }
  // Libraries that test for the global object need the rule relaxed (allowlisting is the real gate).
  const relaxed = toolConfig({ check: { restrictGlobalObject: false } });
  assert.deepEqual(
    checkToolBundle("export const root = typeof globalThis == 'object' && globalThis;", relaxed)
      .problems,
    [],
  );
  assert.equal(
    checkToolBundle("export const p = () => globalThis.process;", relaxed).ok,
    false,
    "forbidden keys stay forbidden",
  );
  assert.equal(matchesPattern("cloudflare:workers", ["cloudflare:*"]), true);
  assert.equal(matchesPattern("@scope/x/lib", ["@scope/*/lib"]), true);
  assert.equal(matchesPattern("node:fs", ["cloudflare:*"]), false);
});

test("process.env.NODE_ENV and global work; process has no host access", async () => {
  const out =
    await build(`export const run = () => ({ env: process.env.NODE_ENV, g: global.queueMicrotask === globalThis.queueMicrotask,
    cwd: process.cwd(), keys: Object.keys(process.env) });`);
  assert.equal(out.check.ok, true, out.check.problems.join("; "));
  assert.deepEqual(await runTool(out), {
    env: "production",
    g: true,
    cwd: "/",
    keys: ["NODE_ENV"],
  });
});

test("named imports from denied builtins link, and throw on use", async () => {
  const out =
    await build(`import { Buffer } from "node:buffer"; import { createHash } from "crypto";
import { EventEmitter } from "events"; import { homedir } from "os";
export const run = () => { const r: string[] = [];
  for (const f of [() => Buffer.from("x"), () => createHash("sha1"), () => new EventEmitter(), () => homedir()])
    try { f(); r.push("ran"); } catch (e: any) { r.push(e.message); }
  return r; };`);
  assert.equal(out.check.ok, true, out.check.problems.join("; "));
  assert.deepEqual(await runTool(out), [
    "ENOSYS: node:buffer is not available to tools",
    "ENOSYS: crypto is not available to tools",
    "ENOSYS: events is not available to tools",
    "ENOSYS: os is not available to tools",
  ]);
});

test("fs shim: Buffer-like reads, encodings, binary writes, fs/promises, constants, stats, errors", async () => {
  const out =
    await build(`import fs, { lstatSync, realpath } from "node:fs"; import fsp from "node:fs/promises";
export async function run() {
  const r: any = {};
  const buf: any = await fsp.readFile("/allowed/a.json");
  r.text = buf.toString(); r.json = JSON.parse(buf).k; r.hex = buf.toString("hex");
  r.latin1 = await fsp.readFile("/allowed/a.json", "latin1"); r.b64 = await fsp.readFile("/allowed/a.json", { encoding: "base64" });
  await fsp.writeFile("/allowed/u16.txt", new Uint8Array([104, 105]));
  try { await fsp.writeFile("/allowed/bin", new Uint8Array([0xff, 0xfe])); r.bin = "stored"; } catch (e: any) { r.bin = e.code; }
  r.promises = fs.promises === fsp; r.F_OK = fs.constants.F_OK;
  r.mtimeMs = typeof (await fsp.stat("/allowed/a.json")).mtimeMs;
  try { lstatSync("/allowed/a.json"); } catch (e: any) { r.sync = e.code; }
  try { await fsp.readFile("/secret"); } catch (e: any) { r.err = [e.code, e.errno, e.syscall, e.path]; }
  r.realpath = typeof realpath;
  return r;
}`);
  assert.equal(out.check.ok, true, out.check.problems.join("; "));
  const files = fakeFiles({ "/allowed/a.json": '{"k":"é"}' });
  assert.deepEqual(await runTool(out, files), {
    text: '{"k":"é"}',
    json: "é",
    hex: "7b226b223a22c3a9227d",
    latin1: '{"k":"Ã©"}',
    b64: "eyJrIjoiw6kifQ==",
    bin: "stored",
    promises: true,
    F_OK: 0,
    mtimeMs: "number",
    sync: "ENOSYS",
    err: ["EACCES", -13, "readFile", "/secret"],
    realpath: "function",
  });
  assert.deepEqual([...files.data.get("/allowed/u16.txt")], [104, 105]);
  assert.deepEqual([...files.data.get("/allowed/bin")], [0xff, 0xfe]);
});

test("fs shim without a bound capability fails with EACCES; path shim parses and formats", async () => {
  const out = await build(`import { readdir } from "node:fs/promises"; import path from "node:path";
export async function run() {
  let e1 = ""; try { await readdir("/"); } catch (e: any) { e1 = e.code; }
  return { e1, parse: path.parse("/a/b.md"), format: path.format({ dir: "/a", name: "b", ext: ".md" }),
    trailing: path.normalize("a/"), posix: path.posix.posix === path.posix, rel: path.relative("/a/b", "/a/c/d") };
}`);
  const Tool = await load(out.code);
  const r = await new Tool().run(null, {}); // no capability bound
  assert.deepEqual(r, {
    e1: "EACCES",
    parse: { root: "/", dir: "/a", base: "b.md", ext: ".md", name: "b" },
    format: "/a/b.md",
    trailing: "a/",
    posix: true,
    rel: "../c/d",
  });
});

test("a default-exported class is refused with EINVAL; the generated entry is removed", async () => {
  const { MemFilesApi } = await import("@statewalker/webrun-files-mem");
  const files = new MemFilesApi();
  const out = await bundleTool({
    esbuild,
    files,
    root: "/t",
    sources: { "/index.ts": "export default class T { run() { return 1; } }" },
    entry: "/index.ts",
    config: RUN_IN_NODE,
  });
  await assert.rejects(runTool(out), /EINVAL: the tool's default export is a class/);
  assert.equal(await files.exists("/t/__capfs_tool_entry__.js"), false);
});

test("admitTool: the policy comes from the deployment; host-fs runtimes need approved bundles", async () => {
  const LOADER = {};
  const bundle = (
    await build("export const run = () => 1;", { external: ["cloudflare:workers"], modules: {} })
  ).code;
  const hash = await bundleHash(bundle);
  const raw = "export default class {}";
  const eperm = (p) => assert.rejects(p, /^Error: EPERM/);
  const admit = (code, bundled, policy, overrides) =>
    admitTool({ code, bundled }, policy, toolConfig(overrides));

  assert.equal(toolPolicy({}, toolConfig(), false), "none");
  assert.equal(toolPolicy({ LOADER }, toolConfig(), false), "isolated");
  assert.equal(toolPolicy({ LOADER }, toolConfig(), true), "refused");
  assert.equal(
    toolPolicy({ LOADER }, toolConfig({ hostFsRuntimes: "bundled-only" }), true),
    "bundled-only",
  );
  assert.equal(toolPolicy({ LOADER, ALLOW_HOST_FS_TOOLS: "1" }, toolConfig(), true), "isolated");

  await admit(raw, false, "isolated"); // workerd: raw modules run
  await admit(bundle, true, "isolated");
  await eperm(admit(raw, false, "isolated", { requireBundled: true }));
  await admit(bundle, true, "isolated", { requireBundled: true });
  await eperm(admit(`${bundle}\nexport const x = () => import("y");`, true, "isolated")); // fails the check
  await eperm(admit(bundle, true, "refused"));
  await eperm(admit(bundle, true, "bundled-only")); // a checked bundle is not enough: not approved
  await eperm(admit(raw, false, "bundled-only", { allowedBundles: [hash] }));
  await admit(bundle, true, "bundled-only", { allowedBundles: [hash] });
  await eperm(admit(`${bundle}\n`, true, "bundled-only", { allowedBundles: [hash] })); // any change → new hash
  await eperm(admit(raw, false, "isolated", { allowedBundles: [hash] })); // a list applies everywhere
});
