import type { Criterion } from "../src/types.js";

/** Parse every numbered criterion out of the specification's markdown. */
export function parseCriteria(spec: string): Criterion[];

/** Render a criteria registry as the contents of `src/criteria.ts`. */
export function render(criteria: Criterion[], specPath: string): string;
