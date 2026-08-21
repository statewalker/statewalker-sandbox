/**
 * Adapter over `@statewalker/httpeers.core`, to measure it against the spec.
 *
 * WHAT IS DELIBERATELY NOT MAPPED, and why it reports `missing` rather than `fail`:
 *
 * `tokens` and `policy` — core implements a DIFFERENT mechanism, not a partial one.
 * Its tokens are JWT-shaped with the binding carried by `sub` (spec: a confirmation
 * claim, ADR-0009), no audience (ADR-0020), and no delegation (ADR-0010); its policy
 * is the walked `.access` tree with a standalone vocabulary, which ADR-0019 replaced
 * with Datalog. The spec's `verify` takes a Datalog rule set, which core cannot
 * consume at all.
 *
 * Adapting around that — translating Datalog into tree lookups inside this file —
 * would report conformance the package does not have, and would test the adapter's
 * translation rather than core. Divergences D-06, D-07, D-14, D-15 and D-16 of §13
 * are exactly this gap, and `missing` is the outcome that names it.
 *
 * `intermediary` — no equivalent exists (D-11).
 *
 * `mounts` IS mapped, because core offers the capability and the interesting question
 * is how it behaves. Expect R-01..R-04 to pass and R-05..R-07 to FAIL: core's
 * `provide()` normalises prefixes and accepts duplicates where ADR-0006 requires a
 * throw naming every conflict (D-09).
 */
import { createMounts } from "@statewalker/httpeers.core";
import type { FetchHandler, Implementation, MountsTable } from "../src/types.js";

export const httpeersCoreImplementation: Implementation = {
  name: "@statewalker/httpeers.core",
  notes:
    "Built by the httpeers-stack plan against the pre-ADR-0019 design. Its token and " +
    "policy mechanisms are superseded rather than incomplete; see this file's header.",
  mounts: {
    build(defs: Record<string, FetchHandler>): MountsTable {
      const m = createMounts();
      for (const [prefix, handler] of Object.entries(defs)) m.provide(prefix, handler);
      return { resolve: (path) => m.match(path) };
    },
  },
  // tokens / policy / intermediary: absent by design — see the header.
};
