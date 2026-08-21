import type { Check } from "../types.js";
import { ACCESS_CHECKS } from "./access.js";
import { OTHER_CHECKS } from "./other.js";
import { ROUTER_CHECKS } from "./router.js";

export type CheckEntry = Check | { skip: string };

/** Every criterion must appear here exactly once. Enforced by tests/coverage.test.ts. */
export const CHECKS: Record<string, CheckEntry> = {
  ...ROUTER_CHECKS,
  ...ACCESS_CHECKS,
  ...OTHER_CHECKS,
};
