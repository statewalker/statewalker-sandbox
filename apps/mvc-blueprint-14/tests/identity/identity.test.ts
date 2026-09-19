import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * J1's zero-change proof (acceptance 1): every source file of P0 (`apps/mvc-blueprint-04/src`) —
 * kernel, kits, every bundle (Todos, Contacts, shell, hello, their React and DOM renderers), the
 * features and applications — exists here byte for byte. The only P0 file J1 edits is the dev
 * entry `src/main.ts` (one more application in the picker). The set is derived from P0's tree,
 * not listed, so a file P0 adds later is covered too.
 */
const HERE = new URL("../../", import.meta.url).pathname;
const P0 = join(HERE, "../mvc-blueprint-04/");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const EDITED = new Set(["src/main.ts"]);
const p0Set = walk(join(P0, "src"))
  .map((p) => relative(P0, p))
  .filter((f) => !EDITED.has(f))
  .sort();
const todosAndContacts = p0Set.filter((f) => /^src\/bundles\/(?:todos|contacts)[./]/.test(f));
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("P0 unchanged under J1", () => {
  it("P0 is present; 71 files, 29 of them Todos and Contacts", () => {
    expect(existsSync(P0)).toBe(true);
    expect(p0Set.length).toBe(71);
    expect(todosAndContacts.length).toBe(29);
  });

  it.each(p0Set)("%s is byte-identical to P0's", (file) => {
    expect(existsSync(join(HERE, file)), `missing ${file}`).toBe(true);
    expect(sha(join(HERE, file))).toBe(sha(join(P0, file)));
  });

  it("no new file inside a P0 bundle folder (J1 only adds bundles)", () => {
    const p0Dirs = new Set(p0Set.map((f) => f.split("/").slice(0, 3).join("/")));
    const extra = walk(join(HERE, "src"))
      .map((p) => relative(HERE, p))
      .filter((f) => p0Dirs.has(f.split("/").slice(0, 3).join("/")))
      .filter((f) => !p0Set.includes(f) && !EDITED.has(f))
      .filter((f) => !/^src\/(?:features|apps)\//.test(f)); // new manifests beside P0's
    expect(extra).toEqual([]);
  });

  it("negative control: a one-byte change is detected", () => {
    const file = join(HERE, p0Set[0] as string);
    const changed = createHash("sha256")
      .update(Buffer.concat([readFileSync(file), Buffer.from(" ")]))
      .digest("hex");
    expect(changed).not.toBe(sha(join(P0, p0Set[0] as string)));
  });
});
