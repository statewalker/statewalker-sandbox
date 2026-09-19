import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * U1's zero-change proof, reused: every non-UI file of P0 (`apps/mvc-blueprint-04`) — kernel, kits
 * other than React/DOM, every logic bundle and API module other than the React/DOM renderer
 * extension points, the logic features — plus P0's technology-neutral e2e driver and scenarios,
 * exists here byte for byte. The set is derived from P0's tree by rule, not listed, so a file P0
 * adds later is covered too.
 *
 * J2 adds: the two shell hosts are reused unchanged — P0's React host and U1's Solid host, with
 * their binding kits and renderer extension points. The Solid files differ from U1's by ONE
 * prepended line, the `@jsxImportSource solid-js` pragma that lets React and Solid `.tsx`
 * type-check in one project; the comparison strips exactly that line and nothing else.
 */
const HERE = new URL("../../", import.meta.url).pathname;
const P0 = join(HERE, "../mvc-blueprint-04/");
const U1 = join(HERE, "../mvc-blueprint-08/");
const PRAGMA = "/** @jsxImportSource solid-js */\n";

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

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const shaNoPragma = (path: string) => {
  const text = readFileSync(path, "utf8");
  return createHash("sha256")
    .update(text.startsWith(PRAGMA) ? text.slice(PRAGMA.length) : text)
    .digest("hex");
};

/** The reused hosts: P0's React host (+ its kit and extension point), U1's Solid host (+ same). */
const hostSets = [
  [P0, ["src/kits/react", "src/bundles/shell.react", "src/bundles/shell/api/react"]],
  [U1, ["src/kits/solid", "src/bundles/shell.solid", "src/bundles/shell/api/solid"]],
] as const;
const hostFiles = hostSets.flatMap(([from, dirs]) =>
  dirs.flatMap((d) => walk(join(from, d)).map((p) => [relative(from, p), from] as const)),
);

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

  it("the reused shell hosts: 10 files, P0's React host and U1's Solid host", () => {
    expect(hostFiles.length).toBe(10);
  });

  it.each(hostFiles)(
    "host %s is the original's bytes (Solid: minus the JSX pragma)",
    (file, from) => {
      expect(existsSync(join(HERE, file)), `missing ${file}`).toBe(true);
      expect(shaNoPragma(join(HERE, file))).toBe(sha(join(from, file)));
    },
  );

  it("no file here shadows a P0 logic file under another name (nothing else in logic folders)", () => {
    const logicDirs = new Set(logicSet.map((f) => f.split("/").slice(0, 3).join("/")));
    const extra = walk(join(HERE, "src"))
      .map((p) => relative(HERE, p))
      .filter((f) => logicDirs.has(f.split("/").slice(0, 3).join("/")))
      .filter((f) => !logicSet.includes(f))
      // Renderer extension points (P0's react, U1's solid, J2's jr) sit beside the neutral shell API.
      .filter((f) => !/^src\/bundles\/shell\/api\/(?:react|solid|jr)\//.test(f));
    expect(extra).toEqual([]);
  });

  it("negative control: a one-byte change is detected", () => {
    const file = join(HERE, logicSet[0] as string);
    const changed = createHash("sha256")
      .update(Buffer.concat([readFileSync(file), Buffer.from(" ")]))
      .digest("hex");
    expect(changed).not.toBe(sha(join(P0, logicSet[0] as string)));
  });
});
