import { afterAll, describe, it } from "vitest";
import { CHECKS } from "./checks/index.js";
import { CRITERIA } from "./criteria.js";
import { type Criterion, type Implementation, NotImplemented, NotTestable } from "./types.js";

export type Outcome = "pass" | "fail" | "missing" | "skip";

export interface Record_ {
  criterion: Criterion;
  outcome: Outcome;
  detail?: string;
}

const ledgers = new Map<string, Record_[]>();

/** The outcomes recorded for an implementation, after its suite has run. */
export const ledgerFor = (name: string): Record_[] => ledgers.get(name) ?? [];

function summarise(name: string, rows: Record_[]): string {
  const by = (o: Outcome) => rows.filter((r) => r.outcome === o);
  const lines = [
    "",
    "─".repeat(78),
    `conformance: ${name}`,
    "─".repeat(78),
    `  ${by("pass").length} pass   ${by("fail").length} fail   ` +
      `${by("missing").length} missing   ${by("skip").length} skip   (${rows.length} criteria)`,
  ];
  const missing = by("missing");
  if (missing.length) {
    lines.push("", "  MISSING — the implementation does not offer the capability at all:");
    for (const r of missing) lines.push(`    ${r.criterion.id.padEnd(7)} ${r.detail ?? ""}`);
  }
  const failed = by("fail");
  if (failed.length) {
    lines.push("", "  FAIL — offered, but does not behave as specified:");
    for (const r of failed)
      lines.push(`    ${r.criterion.id.padEnd(7)} ${(r.detail ?? "").split("\n")[0]}`);
  }
  lines.push("─".repeat(78), "");
  return lines.join("\n");
}

/**
 * Run every criterion against one implementation.
 *
 * `missing` is reported as a test failure — a capability the spec requires and the
 * implementation does not have is a divergence, not a neutral fact — but it is
 * labelled distinctly so the summary can separate "never built" from "built wrong".
 */
export function describeConformance(impl: Implementation): void {
  const rows: Record_[] = [];
  ledgers.set(impl.name, rows);

  describe(`httpeers conformance — ${impl.name}`, () => {
    afterAll(() => {
      // eslint-disable-next-line no-console
      console.log(summarise(impl.name, rows));
    });

    for (const criterion of CRITERIA) {
      const entry = CHECKS[criterion.id];
      const name = `${criterion.id} — ${criterion.claim}`;

      if (!entry) {
        it(name, () => {
          rows.push({
            criterion,
            outcome: "fail",
            detail: "no check is registered for this criterion",
          });
          throw new Error(
            `${criterion.id} has no check. Every criterion needs one or an explicit skip reason ` +
              `— a criterion with no outcome is how a suite quietly stops testing.`,
          );
        });
        continue;
      }

      if (typeof entry === "object") {
        it.skip(`${name}  [skipped: ${entry.skip}]`, () => {});
        rows.push({ criterion, outcome: "skip", detail: entry.skip });
        continue;
      }

      it(name, async (ctx) => {
        try {
          await entry(impl);
          rows.push({ criterion, outcome: "pass" });
        } catch (e) {
          if (e instanceof NotTestable) {
            rows.push({ criterion, outcome: "skip", detail: e.message });
            ctx.skip();
            return;
          }
          const detail = e instanceof Error ? e.message : String(e);
          if (e instanceof NotImplemented) {
            rows.push({ criterion, outcome: "missing", detail });
            throw new Error(`MISSING (divergence from the spec): ${detail}`);
          }
          rows.push({ criterion, outcome: "fail", detail });
          throw e;
        }
      });
    }
  });
}
