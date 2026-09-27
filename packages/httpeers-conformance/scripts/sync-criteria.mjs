#!/usr/bin/env node
// Regenerate src/criteria.ts from the specification.
//
// The registry is GENERATED, never hand-edited, so the suite cannot drift from the
// document it claims to test. `tests/coverage.test.ts` fails if the checked-in
// registry differs from what this script would produce, which turns "the spec moved
// and nobody updated the tests" from a silent condition into a red test.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/**
 * WHICH SPECIFICATION THIS SUITE TRACKS, and why it is still the August one.
 *
 * The parser below now handles both id shapes — `A-01` and `ACC-P2P-4` — and
 * `tests/parse-ids.test.ts` proves it against the libraries design itself. But
 * REPOINTING this constant is a separate act with a real cost: the libraries
 * design's 87 criteria have no checks yet, while the August spec's 85 have 38
 * working ones. Switching now would delete those 38 and leave the suite with
 * nothing runnable — which its own `runnable > 0` guard correctly refuses.
 *
 * So each extraction wave repoints its own block as it gains real checks
 * (design §14), rather than the whole registry moving ahead of the tests.
 * `HTTPEERS_SPEC` overrides this for anyone checking drift against another doc.
 */
const SPEC_RELATIVE = "docs/superpowers/specs/2026-08-20-httpeers-api-design.md";

/**
 * Find the spec by walking UP from here until the path exists.
 *
 * The previous version hard-coded `../../../../../docs/...`, a count valid for
 * exactly one assembly layout — and this repository is checked out under
 * several (`worktrees/<feature>/workspaces/<repo>` and
 * `worktrees/<feature>/<repo>` differ by one level). A wrong count throws
 * ENOENT, which at least fails loudly; the real cost is that nobody can move a
 * worktree without editing a script. `HTTPEERS_SPEC` still wins outright.
 */
function findSpec() {
  if (process.env.HTTPEERS_SPEC) return resolve(process.env.HTTPEERS_SPEC);
  let dir = here;
  for (let up = 0; up < 12; up++) {
    const candidate = join(dir, SPEC_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `sync-criteria: could not find ${SPEC_RELATIVE} above ${here}. ` +
      "Set HTTPEERS_SPEC to point at it.",
  );
}

const SPEC = findSpec();

// Display names only. The block a criterion belongs to is DERIVED from its id
// (see `blockOf`) rather than looked up here — a fixed map is what silently
// excluded every three-segment id when the specification started using them.
const BLOCKS = {
  // The August block API's single-letter blocks.
  T: "Transport & wire",
  R: "Router",
  A: "Access & trust",
  E: "Edges",
  M: "Mesh services",
  X: "Peer & intermediary",
  C: "Cross-cutting",
  // The libraries design's blocks: one per extracted package. The keys are
  // the segments the specification actually writes (`ACC-P2P-4`, `ACC-EXP-9`),
  // not the package names spelled out.
  CORE: "httpeers-core",
  ACC: "httpeers-access",
  P2P: "httpeers-libp2p",
  QR: "httpeers-qr",
  MEM: "httpeers-member",
  HUB: "httpeers-hub",
  EXP: "httpeers-expose",
  GHOST: "httpeers-ghost",
};

/**
 * Which block an id belongs to.
 *
 * `A-01` -> `A`, the first segment. `ACC-CORE-1` -> `CORE`, the segment naming
 * the package, because every criterion in the libraries design is prefixed
 * `ACC-` and grouping them all under "ACC" would be one block containing
 * everything.
 */
export function blockOf(id) {
  const parts = id.split("-");
  return parts.length >= 3 ? parts[parts.length - 2] : parts[0];
}

export function parseCriteria(spec) {
  const out = [];
  // Ids are one or more UPPERCASE segments, then a number, then an optional
  // letter: `A-01`, `T-02a`, `ACC-GHOST-8`, `ACC-P2P-4`. The lookahead that
  // ends a criterion has to admit the same shape, or a multi-segment id would
  // be swallowed into the body of the one before it.
  //
  // A segment is `[A-Z][A-Z0-9]*` — a letter first, DIGITS ALLOWED after. An
  // earlier version of this fix used `[A-Z]+`, which parsed 77 criteria,
  // reported a healthy-looking block breakdown, and silently dropped every
  // `ACC-P2P-*` in the document because of the `2`. That is the same failure
  // this whole change exists to remove, one layer in: a count that looks right
  // is not evidence, which is why `parse-ids.test.ts` asserts against the real
  // specification's own set of prefixes rather than against a number.
  //
  // The end-of-input alternative was missing, so a criterion terminated only
  // by the end of the document matched nothing and was dropped in silence.
  // Every specification so far happened to end with prose after its last
  // criterion, which is why it never showed.
  //
  // It is `(?![\s\S])` and NOT `$`: this regex is /m, where `$` matches the
  // end of every LINE — using it truncates each criterion's body to its first
  // line, losing the `*Falsified by:*` and `**DESIGNED**` markers that follow.
  // That failure is silent too, and worse, because the criterion still appears.
  const re =
    /^- \*\*([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+[a-z]?)\*\*\s+([\s\S]*?)(?=\n- \*\*[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d|\n\n|\n#{2,3} |(?![\s\S]))/gm;
  for (const m of spec.matchAll(re)) {
    const id = m[1];
    const raw = m[2];
    const body = raw.replace(/\s+/g, " ").trim();
    const designed = /\*\*DESIGNED\.?\*\*/.test(raw);
    const claim = body.split(/\*Falsified by:\*|\*Evidence:\*|\*\*DESIGNED/)[0].trim();
    const falsified = body.match(/\*Falsified by:\*\s*([\s\S]*?)(?:\*Evidence:\*|\*\*DESIGNED|$)/);
    const evidence = body.match(/\*Evidence:\*\s*([\s\S]*?)(?:\*\*DESIGNED|$)/);
    out.push({
      id,
      block: blockOf(id),
      claim,
      falsifiedBy: falsified ? falsified[1].replace(/\s+$/, "").replace(/\.$/, "") : null,
      evidence: evidence ? evidence[1].replace(/\s+$/, "").replace(/\.$/, "") : null,
      designed,
    });
  }
  return out;
}

export function render(criteria, specPath) {
  const lines = [
    "// GENERATED by scripts/sync-criteria.mjs — do not edit by hand.",
    `// Source: ${specPath.split("/").slice(-1)[0]}`,
    "//",
    "// Every entry is one numbered criterion of the httpeers block API. The suite",
    "// asserts it has an outcome for each of them, so a criterion cannot be quietly",
    "// dropped.",
    "",
    'import type { Criterion } from "./types.js";',
    "",
    `export const BLOCKS: Record<string, string> = ${JSON.stringify(BLOCKS, null, 2)};`,
    "",
    "export const CRITERIA: readonly Criterion[] = [",
  ];
  for (const c of criteria) {
    lines.push(`  {`);
    lines.push(`    id: ${JSON.stringify(c.id)},`);
    lines.push(`    block: ${JSON.stringify(c.block)},`);
    lines.push(`    claim: ${JSON.stringify(c.claim)},`);
    lines.push(`    falsifiedBy: ${JSON.stringify(c.falsifiedBy)},`);
    lines.push(`    evidence: ${JSON.stringify(c.evidence)},`);
    lines.push(`    designed: ${c.designed},`);
    lines.push(`  },`);
  }
  lines.push("] as const;", "");
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const spec = readFileSync(SPEC, "utf8");
  const criteria = parseCriteria(spec);
  if (criteria.length === 0) throw new Error(`no criteria parsed from ${SPEC}`);
  writeFileSync(join(here, "../src/criteria.ts"), render(criteria, SPEC));
  const byBlock = {};
  for (const c of criteria) byBlock[c.block] = (byBlock[c.block] ?? 0) + 1;
  console.log(
    `${criteria.length} criteria -> src/criteria.ts  (` +
      Object.entries(byBlock)
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") +
      `; ${criteria.filter((c) => c.designed).length} DESIGNED)`,
  );
}
