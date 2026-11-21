import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../src");
const NODE_BUILTINS = new Set(builtinModules);

/** Every module reachable from `entry` through relative imports, with the bare specifiers each one imports. */
async function graph(entry: string): Promise<Map<string, string[]>> {
  const seen = new Map<string, string[]>();
  const visit = async (file: string) => {
    if (seen.has(file)) return;
    const source = await readFile(file, "utf8");
    // `import x from "m"`, `export … from "m"`, `import "m"` and `import("m")`
    const specifiers = [
      ...source.matchAll(/(?:^|;|\n)\s*(?:import|export)\b[^"';]*?["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\(\s*["']([^"']+)["']/g),
    ].map((m) => m[1] as string);
    seen.set(
      file,
      specifiers.filter((s) => !s.startsWith(".")),
    );
    for (const s of specifiers.filter((s) => s.startsWith(".")))
      await visit(resolve(dirname(file), s));
  };
  await visit(resolve(SRC, entry));
  return seen;
}

it("the web entry (REST app, MCP, client) imports no Node built-in, directly or indirectly", async () => {
  const modules = await graph("web.ts");
  expect([...modules.keys()].map((f) => f.slice(SRC.length + 1))).toEqual(
    expect.arrayContaining(["rest.ts", "mcp.ts", "client.ts"]),
  );
  const offending = [...modules].flatMap(([file, bare]) =>
    bare
      .filter((s) => s.startsWith("node:") || NODE_BUILTINS.has(s))
      .map((s) => `${file.slice(SRC.length + 1)} imports ${s}`),
  );
  expect(offending).toEqual([]);
});
