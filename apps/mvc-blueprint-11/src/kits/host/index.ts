import {
  type CoverageEntry,
  type CoverageReport,
  type CoverageView,
  dialogsSlot,
  panelsSlot,
  type UnobservedEntry,
} from "@b/shell/api";
import type { KernelSlots, KeyedSlotDeclaration, ViewKind } from "@kernel";

/** Slot keys a shell host renders itself — never "unobserved" while a host is up. */
const HOST_SLOTS = new Set(["shell:header", "shell:menu", "shell:notifications"]);

/**
 * A host's coverage report: panels and dialogs whose kind has no renderer in `renderers`, and slots
 * that hold contributions no one observes (e.g. an action contributed to an absent app's extension
 * point). A gap, never an exception. `getReport()` recomputes and keeps identity while unchanged.
 */
export function createCoverage(
  slots: KernelSlots,
  renderers: KeyedSlotDeclaration<{ readonly kind: ViewKind<unknown> }>,
): CoverageView & { dispose(): void } {
  let cached: CoverageReport = Object.freeze({ unrendered: [], unobserved: [] });
  let cachedKey = "";
  const listeners = new Set<() => void>();
  const compute = (): CoverageReport => {
    const kinds = slots.getSnapshot(renderers);
    const unrendered: CoverageEntry[] = [];
    for (const decl of [panelsSlot, dialogsSlot]) {
      for (const [id, c] of slots.getSnapshot(decl)) {
        if (!kinds.has(c.kind.id)) unrendered.push({ slot: decl.key, id, kind: c.kind.id });
      }
    }
    const unobserved: UnobservedEntry[] = slots
      .usage()
      .filter((u) => u.contributions > 0 && u.observers === 0 && !HOST_SLOTS.has(u.key))
      .map((u) => ({ slot: u.key, contributions: u.contributions }));
    const key = JSON.stringify([unrendered, unobserved]);
    if (key !== cachedKey) {
      cachedKey = key;
      cached = Object.freeze({ unrendered, unobserved });
    }
    return cached;
  };
  const notify = () => {
    const before = cached;
    compute();
    if (before === cached) return;
    for (const l of [...listeners]) {
      try {
        l();
      } catch (error) {
        console.error(error);
      }
    }
  };
  const offs = [
    slots.observe(panelsSlot, notify),
    slots.observe(dialogsSlot, notify),
    slots.observe(renderers, notify),
  ];
  return {
    getReport: compute,
    onReportUpdate(listener) {
      listeners.add(listener);
      listener();
      return () => void listeners.delete(listener);
    },
    dispose() {
      for (const off of offs) off();
      listeners.clear();
    },
  };
}

/** Formats a report for a log line or a test's console. */
export function formatCoverage(report: CoverageReport): string {
  const lines = [
    ...report.unrendered.map((u) => `unrendered ${u.slot} ${u.id} (kind ${u.kind})`),
    ...report.unobserved.map((u) => `unobserved ${u.slot} (${u.contributions} contribution(s))`),
  ];
  return lines.length === 0 ? "coverage: complete" : `coverage:\n  ${lines.join("\n  ")}`;
}
