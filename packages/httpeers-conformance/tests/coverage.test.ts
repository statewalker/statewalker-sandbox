/**
 * The suite's own integrity. Two ways a conformance suite rots quietly:
 * a criterion loses its check, or the spec moves and the registry does not.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKS } from "../src/checks/index.js";
import { CRITERIA } from "../src/criteria.js";
import { parseCriteria, render } from "../scripts/sync-criteria.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(join(here, "../../../../../docs/superpowers/specs/2026-08-20-httpeers-api-design.md"));

describe("conformance suite integrity", () => {
  it("every criterion has a check or an explicit skip reason", () => {
    const orphans = CRITERIA.filter((c) => !CHECKS[c.id]).map((c) => c.id);
    expect(orphans, `criteria with no check: ${orphans.join(", ")}`).toEqual([]);
  });

  it("no check exists for a criterion the spec does not define", () => {
    const ids = new Set(CRITERIA.map((c) => c.id));
    const strays = Object.keys(CHECKS).filter((id) => !ids.has(id));
    expect(strays, `checks with no criterion: ${strays.join(", ")}`).toEqual([]);
  });

  it("every skip states a reason", () => {
    const mute = Object.entries(CHECKS)
      .filter(([, v]) => typeof v === "object" && !String((v as { skip: string }).skip).trim())
      .map(([k]) => k);
    expect(mute).toEqual([]);
  });

  it("the registry matches the specification (no drift)", () => {
    const regenerated = render(parseCriteria(readFileSync(SPEC, "utf8")), SPEC);
    const current = readFileSync(join(here, "../src/criteria.ts"), "utf8");
    expect(
      regenerated === current,
      "src/criteria.ts is stale — the spec changed. Run `pnpm sync-criteria`, then give every " +
        "new criterion a check or a skip reason.",
    ).toBe(true);
  });

  it("reports how much of the spec is actually exercised", () => {
    const runnable = CRITERIA.filter((c) => typeof CHECKS[c.id] === "function").length;
    const skipped = CRITERIA.length - runnable;
    // Not an assertion about a good number — a printed fact, so the ratio is visible
    // rather than buried. Blocks T, E and M are out of this harness by construction.
    console.log(
      `\n  ${runnable}/${CRITERIA.length} criteria are executable here; ` +
        `${skipped} need a transport, a hub, an edge, or a live peer.\n`,
    );
    expect(runnable).toBeGreaterThan(0);
  });
});
