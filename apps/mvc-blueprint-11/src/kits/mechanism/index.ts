import { type Context, type Controller, getConfig } from "@kernel";

/**
 * P3's switch: which commit mechanism the affected bundles run. Read from
 * `sys:config["commit:mechanism"]` at activation; default `A` (the P0 baseline).
 * - A — controller snapshot (P0): the submit listener captures what the commit means.
 * - B — form commit: the form model freezes its draft at submit and hands it over.
 * - C — action-bound commit records: the action captures `{ seq, snapshot }` at submit.
 */
export type Mechanism = "A" | "B" | "C";
export const MECHANISM_KEY = "commit:mechanism";

export function mechanismOf(context: Context): Mechanism {
  const value = getConfig(context)[MECHANISM_KEY];
  return value === "B" || value === "C" ? value : "A";
}

/** A bundle's activator that delegates to the variant the configuration names. */
export function byMechanism(variants: Readonly<Record<Mechanism, Controller>>): Controller {
  return (context) => variants[mechanismOf(context)](context);
}
