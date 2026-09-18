import { shellCoverage } from "@b/shell/api";
import { type Controller, getSlots, type KeyedSlotDeclaration, type ViewKind } from "@kernel";
import { createCoverage } from "@kit/host";

/**
 * The trivial test shell, headless variant: the slots bus IS the record of contributions (tests
 * read `sys:slots`); this activator only provides the coverage report against one technology's
 * renderer slot, as any shell host must.
 */
export function headlessShell(
  renderers: KeyedSlotDeclaration<{ readonly kind: ViewKind<unknown> }>,
): Controller {
  return async (context) => {
    const slots = getSlots(context);
    const coverage = createCoverage(slots, renderers);
    shellCoverage.set(context, coverage);
    return () => coverage.dispose();
  };
}
