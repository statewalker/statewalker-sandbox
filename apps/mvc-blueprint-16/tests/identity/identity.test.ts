import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * J3's zero-change proof (U1's, reused): every non-UI file of P0 (`apps/mvc-blueprint-04`) — kernel, kits other
 * than React/DOM, every logic bundle and API module other than the React/DOM renderer extension
 * points, the logic features — plus P0's technology-neutral e2e driver and scenarios, exists here
 * byte for byte. The set is derived from P0's tree by rule, not listed, so a file P0 adds later
 * is covered too.
 */
const HERE = new URL("../../", import.meta.url).pathname;
const P0 = join(HERE, "../mvc-blueprint-04/");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** What is UI in P0: React/DOM kits, renderer bundles, shell hosts, the React/DOM renderer APIs. */
const P0_UI =
  /^src\/kits\/(?:react|dom)\/|^src\/bundles\/[^/]*\.ui\.|^src\/bundles\/shell\.(?:react|dom|test)\/|^src\/bundles\/shell\/api\/(?:react|dom)\//;

const logicSet = [
  ...["src/kernel", "src/kits", "src/bundles"].flatMap((d) =>
    walk(join(P0, d)).map((p) => relative(P0, p)),
  ),
  "src/features/logic.ts",
]
  .filter((f) => !P0_UI.test(f))
  .sort();
const e2eSet = ["tests/e2e/dom.ts", "tests/e2e/scenarios.ts", "tests/support/logging.ts"];

/** J3 changes only the renderers: the shell hosts, their bindings and extension points are reused. */
const U1 = join(HERE, "../mvc-blueprint-08/");
const reusedUi: [string, string][] = [
  ...[
    "src/kits/dom",
    "src/bundles/shell.dom",
    "src/bundles/shell.test",
    "src/bundles/shell/api/dom",
  ]
    .flatMap((d) => walk(join(P0, d)))
    .map((p): [string, string] => [relative(P0, p), P0]),
  ...["src/kits/solid", "src/bundles/shell.solid", "src/bundles/shell/api/solid"]
    .flatMap((d) => walk(join(U1, d)))
    .map((p): [string, string] => [relative(U1, p), U1]),
];

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("P0's logic, unchanged", () => {
  it("P0 is present and the logic set is what the README says (42 files)", () => {
    expect(existsSync(P0)).toBe(true);
    expect(logicSet.length).toBe(42);
  });

  it.each(logicSet)("%s is byte-identical to P0's", (file) => {
    expect(existsSync(join(HERE, file)), `missing ${file}`).toBe(true);
    expect(sha(join(HERE, file))).toBe(sha(join(P0, file)));
  });

  it.each(e2eSet)("e2e driver %s is byte-identical to P0's", (file) => {
    expect(sha(join(HERE, file))).toBe(sha(join(P0, file)));
  });

  it("no file here shadows a P0 logic file under another name (nothing else in logic folders)", () => {
    const logicDirs = new Set(logicSet.map((f) => f.split("/").slice(0, 3).join("/")));
    const extra = walk(join(HERE, "src"))
      .map((p) => relative(HERE, p))
      .filter((f) => logicDirs.has(f.split("/").slice(0, 3).join("/")))
      .filter((f) => !logicSet.includes(f))
      // New extension points sit beside P0's react/dom ones: Solid's renderers and the view specs.
      .filter((f) => !/^src\/bundles\/shell\/api\/(?:dom|solid|spec)\//.test(f));
    expect(extra).toEqual([]);
  });

  it.each(reusedUi)("reused UI %s is byte-identical to its source (P0 or U1)", (file, from) => {
    expect(existsSync(join(HERE, file)), `missing ${file}`).toBe(true);
    expect(sha(join(HERE, file))).toBe(sha(join(from, file)));
  });

  it("negative control: a one-byte change is detected", () => {
    const file = join(HERE, logicSet[0] as string);
    const changed = createHash("sha256")
      .update(Buffer.concat([readFileSync(file), Buffer.from(" ")]))
      .digest("hex");
    expect(changed).not.toBe(sha(join(P0, logicSet[0] as string)));
  });
});
