// What a caller may send to have a tool bundled in the deployment.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUNDLE_LIMITS, checkBundleRequest } from "../../src/tools/bundle-request.ts";
import { toolConfig } from "../../src/tools/config.ts";

const deployment = toolConfig({ external: ["cloudflare:workers"] });
const ok = (req) => checkBundleRequest(req, deployment);
const bad = (req, re) => assert.throws(() => ok(req), re);
const src = { "/index.ts": "export default () => 1" };

test("sources, entry and paths", () => {
  assert.equal(ok({ sources: src, entry: "index.ts" }).entry, "/index.ts");
  bad({ sources: src, entry: "/other.ts" }, /entry/);
  bad({ sources: {}, entry: "/index.ts" }, /1 to/);
  bad({ sources: { "/a.ts": 1 }, entry: "/a.ts" }, /path → source/);
  for (const p of [
    "a.ts",
    "//a.ts",
    "/./a.ts",
    "/x/../a.ts",
    "/a.ts/",
    "/a b.ts",
    "/__capfs_tool_entry__.js",
  ])
    bad({ sources: { [p]: "", "/index.ts": "" }, entry: "/index.ts" }, /EINVAL/);
});

test("only build-side keys, with their shapes; run-side keys stay the deployment's", () => {
  const r = ok({ sources: src, entry: "/index.ts", config: { processEnv: { A: "1" } } });
  assert.deepEqual(r.config.processEnv, { A: "1" });
  assert.deepEqual(r.config.external, ["cloudflare:workers"]);
  bad({ sources: src, entry: "/index.ts", config: { external: ["node:fs"] } }, /deployment's/);
  bad({ sources: src, entry: "/index.ts", config: { check: {} } }, /deployment's/);
  bad({ sources: src, entry: "/index.ts", config: { fsModules: "node:fs" } }, /shape/);
  bad({ sources: src, entry: "/index.ts", config: { define: { x: 1 } } }, /shape/);
  bad({ sources: src, entry: "/index.ts", config: [] }, /config/);
});

test("the size limit counts UTF-8 bytes of sources and config together", () => {
  const big = "é".repeat(BUNDLE_LIMITS.bytes / 2); // as many bytes as the limit, half the characters
  bad({ sources: { "/index.ts": big }, entry: "/index.ts" }, /bytes/);
  const half = "x".repeat(BUNDLE_LIMITS.bytes / 2);
  bad(
    { sources: { "/index.ts": half }, entry: "/index.ts", config: { modules: { m: half } } },
    /bytes/,
  );
  const many = Object.fromEntries(
    Array.from({ length: BUNDLE_LIMITS.files + 1 }, (_, i) => [`/f${i}.ts`, ""]),
  );
  bad({ sources: many, entry: "/f0.ts" }, /1 to/);
});
