// A tool written for Node: node:fs/promises, fs callbacks and node:path. The scenario suite
// bundles it with bundleTool; scripts/run-env.mjs approves exactly this bundle's hash for the
// cellb-bundled-only run (allowedBundles).
import fs from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function run({ dir }: { dir: string }) {
  const names = await readdir(dir);
  const todos: string[] = [];
  for (const n of names) {
    if (!n.endsWith(".md")) continue;
    const text = await readFile(join(dir, n), "utf8");
    todos.push(...text.split("\n").filter((l) => l.includes("TODO")));
  }
  let write = "allowed";
  try {
    await writeFile(join(dir, "report.txt"), todos.join("\n"));
  } catch (e) {
    write = (e as { code: string }).code;
  }
  const p1 = await new Promise((ok) =>
    fs.readFile("/p1/a.txt", "utf8", (e) => ok(e ? e.code : "readable")),
  );
  return { names, todos, write, p1, env: process.env.NODE_ENV };
}
