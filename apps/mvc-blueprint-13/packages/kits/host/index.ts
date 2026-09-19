import {
  type CoverageEntry,
  type CoverageReport,
  type CoverageView,
  dialogsSlot,
  type FailedEntry,
  headerSlot,
  menuSlot,
  notificationsSlot,
  panelsSlot,
  type UnobservedEntry,
} from "@p5/shell/api";
import type { KernelSlots, KeyedSlotDeclaration, ViewKind } from "@p5/kernel";

/** Slot keys a shell host renders itself — never "unobserved" while a host is up. */
const HOST_SLOTS: readonly string[] = ["shell:header", "shell:menu", "shell:notifications"];

/** Whether contribution `id` of the shell slot `slot` is still there (a failure outlives it not). */
function present(slots: KernelSlots, slot: string, id: string): boolean {
  if (slot === panelsSlot.key) return slots.getSnapshot(panelsSlot).has(id);
  if (slot === dialogsSlot.key) return slots.getSnapshot(dialogsSlot).has(id);
  const plain = [headerSlot, menuSlot, notificationsSlot].find((d) => d.key === slot);
  return (
    plain !== undefined && slots.getSnapshot(plain as typeof menuSlot).some((c) => c.id === id)
  );
}

/**
 * A host's coverage report: panels and dialogs whose kind has no renderer in `renderers`, slots
 * that hold contributions no one observes (e.g. an action contributed to an absent app's extension
 * point), and contributions whose rendering failed (`fail`, called by the host's error boundary).
 * A gap, never an exception. `getReport()` recomputes and keeps identity while unchanged.
 */
export function createCoverage(
  slots: KernelSlots,
  renderers: KeyedSlotDeclaration<{ readonly kind: ViewKind<unknown> }>,
): CoverageView & { fail(entry: FailedEntry): void; dispose(): void } {
  let cached: CoverageReport = Object.freeze({ unrendered: [], failed: [], unobserved: [] });
  let cachedKey = "";
  const listeners = new Set<() => void>();
  const failures = new Map<string, FailedEntry>();
  const compute = (): CoverageReport => {
    for (const [key, f] of failures) if (!present(slots, f.slot, f.id)) failures.delete(key);
    const failed = [...failures.values()];
    const kinds = slots.getSnapshot(renderers);
    const unrendered: CoverageEntry[] = [];
    for (const decl of [panelsSlot, dialogsSlot]) {
      for (const [id, c] of slots.getSnapshot(decl)) {
        if (!kinds.has(c.kind.id)) unrendered.push({ slot: decl.key, id, kind: c.kind.id });
      }
    }
    const unobserved: UnobservedEntry[] = slots
      .usage()
      .filter(
        (u) =>
          u.contributions > 0 && u.observers === 0 && !u.command && !HOST_SLOTS.includes(u.key),
      )
      .map((u) => ({ slot: u.key, contributions: u.contributions }));
    const key = JSON.stringify([unrendered, failed, unobserved]);
    if (key !== cachedKey) {
      cachedKey = key;
      cached = Object.freeze({ unrendered, failed, unobserved });
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
    fail(entry) {
      failures.set(`${entry.slot} ${entry.id}`, Object.freeze({ ...entry }));
      notify();
    },
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
    ...report.failed.map((f) => `failed ${f.slot} ${f.id}: ${f.error}`),
    ...report.unobserved.map((u) => `unobserved ${u.slot} (${u.contributions} contribution(s))`),
  ];
  return lines.length === 0 ? "coverage: complete" : `coverage:\n  ${lines.join("\n  ")}`;
}
export * from "./focus.js";
