#!/usr/bin/env node
// What json-render costs in a bundle, per technology. The UI of one workbench — the shared views
// (`*.ui.jr`: specs + bindings) and that technology's `jr.<tech>` (catalog + bridge) — built alone,
// minified; the UI library, the kernel's dependencies and the logic are external. Then again with
// json-render and/or zod external too, to split our code from the third-party runtime.
// Usage: node scripts/size.mjs
import { gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { alias, SOLID_TSX } from "../aliases.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const BASE = [/^react(?:-dom)?(?:\/|$)/, /^solid-js(?:\/|$)/, /^@statewalker\//, /^alien-signals$/];
const JR = /^@json-render\//;
const ZOD = /^zod(?:\/|$)/;

async function size(entries, external) {
  const out = await build({
    root: ROOT,
    logLevel: "silent",
    configFile: false,
    plugins: [solid({ include: SOLID_TSX }), react({ exclude: SOLID_TSX })],
    resolve: { alias },
    build: {
      write: false,
      minify: true,
      lib: { entry: entries, formats: ["es"] },
      rollupOptions: { external: [...BASE, ...external] },
    },
  });
  const code = (Array.isArray(out) ? out : [out])
    .flatMap((o) => o.output)
    .filter((c) => c.type === "chunk")
    .map((c) => c.code)
    .join("\n");
  return { min: code.length, gz: gzipSync(code).length };
}

const kb = ({ min, gz }) => `${(min / 1024).toFixed(1)} KB min / ${(gz / 1024).toFixed(1)} KB gz`;
for (const tech of ["react", "solid"]) {
  const entries = [`src/bundles/jr.${tech}/index.ts`, "src/features/jr.ts"];
  const all = await size(entries, []);
  const noZod = await size(entries, [ZOD]);
  const ours = await size(entries, [JR, ZOD]);
  console.log(`${tech}: UI with json-render + zod     ${kb(all)}`);
  console.log(`${tech}: UI with json-render, zod external ${kb(noZod)}`);
  console.log(`${tech}: our code only (both external)  ${kb(ours)}`);
}
