/**
 * The generator must parse the ids the specification actually uses.
 *
 * It was written against two-segment ids — `A-01`, `T-02`, `R-13` — and a
 * fixed seven-entry block map. The libraries design numbers its criteria
 * `ACC-CORE-1`, `ACC-GHOST-8`, `ACC-MEM-10`: three segments, one per package.
 * The regex matches NONE of them.
 *
 * That is worse than it sounds, because it fails silently in the direction of
 * looking healthy. `coverage.test.ts` compares the checked-in registry against
 * what the generator would produce from the spec, so if the generator sees no
 * criteria in a document, "no drift" is trivially true. The suite has been
 * green while measuring a document nobody is writing to any more.
 *
 * These tests pin both halves: that the ids parse, and that each lands in a
 * block a reader can group by.
 */

import { describe, expect, it } from "vitest";
import { parseCriteria } from "../scripts/sync-criteria.mjs";

/** Both shapes, in the form the specifications really write them. */
const SPEC = `
## 4. Block A

- **A-01** The old two-segment shape still parses.
  *Falsified by:* nothing parsing it.

- **T-02a** A lettered suffix still parses.

## 5. httpeers-core

- **ACC-CORE-1** A mount table resolves the longest matching prefix.
  *Falsified by:* a shorter prefix winning.

- **ACC-GHOST-8** A root-absolute URL from inside a rendered host page is
  refused, not served by the viewer's origin.

- **ACC-MEM-10** Policies are the parameter; a whole rule set is not.
  *Falsified by:* injecting a RuleSet being accepted. **DESIGNED.**
`;

describe("parseCriteria: the ids the spec uses", () => {
  const parsed = parseCriteria(SPEC);
  const ids = parsed.map((c) => c.id);

  it("parses every criterion in the fixture", () => {
    // Guards the guard: a regex that matched nothing would make each
    // membership check below pass vacuously if written as a filter.
    expect(parsed.length).toBe(5);
  });

  it("parses the three-segment ACC-* ids", () => {
    expect(ids).toContain("ACC-CORE-1");
    expect(ids).toContain("ACC-GHOST-8");
    expect(ids).toContain("ACC-MEM-10");
  });

  it("still parses the old two-segment ids, suffix and all", () => {
    // The August spec is still a real document; widening must not drop it.
    expect(ids).toContain("A-01");
    expect(ids).toContain("T-02a");
  });

  it("derives the block from the package segment for a three-segment id", () => {
    expect(parsed.find((c) => c.id === "ACC-CORE-1")?.block).toBe("CORE");
    expect(parsed.find((c) => c.id === "ACC-GHOST-8")?.block).toBe("GHOST");
  });

  it("keeps the first segment as the block for a two-segment id", () => {
    expect(parsed.find((c) => c.id === "A-01")?.block).toBe("A");
    expect(parsed.find((c) => c.id === "T-02a")?.block).toBe("T");
  });

  it("still reads the claim, the falsifier and the DESIGNED marker", () => {
    const mem = parsed.find((c) => c.id === "ACC-MEM-10");
    expect(mem?.claim).toContain("Policies are the parameter");
    expect(mem?.falsifiedBy).toContain("injecting a RuleSet");
    expect(mem?.designed).toBe(true);
    expect(parsed.find((c) => c.id === "ACC-GHOST-8")?.designed).toBe(false);
  });
});

/**
 * The check a count cannot give you.
 *
 * The first version of the widening parsed 77 criteria from the real
 * specification and printed a block breakdown that looked entirely healthy —
 * while silently dropping every `ACC-P2P-*` id, because its segment pattern
 * was `[A-Z]+` and `P2P` contains a digit. An entire package's criteria were
 * missing and nothing said so.
 *
 * So the guard is not "we parsed enough" but "we parsed everything the
 * document declares": scan the spec for id-shaped headings independently of
 * the parser, and require the parser to account for every prefix found.
 */
describe("against the real specification", () => {
  const SPEC_PATH = process.env.HTTPEERS_SPEC;

  it.skipIf(SPEC_PATH == null)("accounts for every id prefix the document uses", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(SPEC_PATH as string, "utf8");

    // Deliberately a DIFFERENT expression from the parser's: if both shared
    // one, a flaw in it would hide from this test exactly as it hid before.
    const declared = new Set(
      [...text.matchAll(/^- \*\*([A-Z][A-Z0-9-]*-\d+[a-z]?)\*\*/gm)].map((m) =>
        (m[1] as string).split("-").slice(0, -1).join("-"),
      ),
    );
    const parsedPrefixes = new Set(
      parseCriteria(text).map((c) => c.id.split("-").slice(0, -1).join("-")),
    );

    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].sort().filter((p) => !parsedPrefixes.has(p))).toEqual([]);
  });
});
