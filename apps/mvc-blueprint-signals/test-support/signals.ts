import type { SignalsImplementation } from "../lib/signals/contract.js";

/**
 * Test-side helpers for signals. For now only the type of what each Vitest
 * project provides; the watchers join it in Task 3.
 */
declare module "vitest" {
  export interface ProvidedContext {
    /** Which implementation this project resolved `@todo/signals` to. */
    signals: SignalsImplementation;
  }
}
