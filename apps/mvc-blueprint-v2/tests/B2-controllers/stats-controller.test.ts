import { StatsController } from "@stats/app";
import { type LogRecord, loggerBackendsSlot, panelsSlot } from "@sys";
import { todosSummary } from "@todo/core";
import { describe, expect, it } from "vitest";
import { newTestContext, settle } from "../support/context.js";

const NOW = 105_000;

const record = (
  seq: number,
  event: string,
  data: unknown,
  over: Partial<LogRecord> = {},
): LogRecord =>
  Object.freeze({
    seq,
    at: NOW,
    level: "info",
    args: [event, data],
    metadata: { module: "todos" },
    dropped: 0,
    ...over,
  });

function boot(summary?: { total: number; done: number }) {
  const t = newTestContext();
  if (summary) t.commands.listen(todosSummary, async () => summary);
  const controller = new StatsController({ now: () => NOW, tickMs: 60_000 });
  controller.activate(t.ctx);
  const write = (r: LogRecord) => {
    for (const backend of t.slots.getSnapshot(loggerBackendsSlot)) backend.write(r);
  };
  return { ...t, controller, write };
}

describe("B2 · stats controller", () => {
  it("contributes one backend and two panels", async () => {
    const { controller, slots } = boot({ total: 0, done: 0 });
    expect(slots.getSnapshot(loggerBackendsSlot)).toHaveLength(1);
    const stats = slots.get(panelsSlot, "stats:overview");
    const inspector = slots.get(panelsSlot, "logs:inspector");
    expect([stats?.kind.id, stats?.placement, stats?.model]).toEqual([
      "stats:overview",
      "side",
      controller.stats.view,
    ]);
    expect([inspector?.kind.id, inspector?.placement, inspector?.model]).toEqual([
      "logs:inspector",
      "bottom",
      controller.inspector.view,
    ]);
    await controller.dispose();
  });

  it("derives cumulative totals from todos:* records, on top of the summary baseline", async () => {
    const { controller, write } = boot({ total: 2, done: 1 });
    await settle();
    write(record(1, "todos:created", { id: "a", title: "a" }));
    write(record(2, "todos:created", { id: "b", title: "b" }));
    write(record(3, "todos:closed", { id: "a" }));
    write(record(4, "todos:reopened", { id: "a" }));
    write(record(5, "todos:removed", { id: "b", done: false }));
    write(record(6, "todos:cleared", { count: 2 }));
    write(
      record(
        7,
        "command:call",
        { key: "todos:add" },
        { metadata: { module: "trace" }, level: "trace" },
      ),
    );
    expect(controller.stats.view.getBaseline()).toEqual({ status: "known", total: 2, done: 1 });
    // open = baseline open (1) + created (2) + reopened (1) - closed (1) - removed while open (1)
    expect(controller.stats.view.getTotals()).toEqual({
      created: 2,
      closed: 1,
      reopened: 1,
      removed: 3,
      open: 2,
    });
    await controller.dispose();
  });

  it("with no todo controller to answer todos:summary, the baseline is unknown and open is undefined", async () => {
    const { controller, write } = boot();
    await settle();
    write(record(1, "todos:created", { id: "a", title: "a" }));
    const baseline = controller.stats.view.getBaseline();
    expect(baseline.status).toBe("unknown");
    expect(controller.stats.view.getTotals().open).toBeUndefined();
    expect(controller.stats.view.getTotals().created).toBe(1);
    await controller.dispose();
  });

  it("totals stay cumulative after the backend has evicted old records", async () => {
    const { controller, write } = boot({ total: 0, done: 0 });
    await settle();
    for (let i = 1; i <= 510; i++) write(record(i, "todos:created", { id: String(i), title: "x" }));
    expect(controller.backend.getRecords()).toHaveLength(500);
    expect(controller.stats.view.getTotals().created).toBe(510);
    await controller.dispose();
  });

  it("buckets created and closed over the last twelve buckets, and recomputes when the bucket changes", async () => {
    const { controller, write } = boot({ total: 0, done: 0 });
    await settle();
    write(record(1, "todos:created", { id: "a", title: "a" }, { at: 95_000 }));
    write(record(2, "todos:closed", { id: "a" }, { at: 101_000 }));
    const ten = controller.stats.view.getTimeline();
    expect(ten).toHaveLength(12);
    expect(ten[11]).toEqual({ start: 100_000, created: 0, closed: 1 });
    expect(ten[10]).toEqual({ start: 90_000, created: 1, closed: 0 });
    controller.stats.view.setBucket(60_000);
    const minute = controller.stats.view.getTimeline();
    expect(minute[11]).toEqual({ start: 60_000, created: 1, closed: 1 });
    await controller.dispose();
  });

  it("the inspector shows records newest first, filtered by level and module, with the module list and dropped count", async () => {
    const { controller, write } = boot({ total: 0, done: 0 });
    await settle();
    write(record(1, "todos:created", { id: "a" }));
    write(
      record(
        2,
        "command:call",
        { key: "todos:add" },
        { level: "trace", metadata: { module: "trace" }, dropped: 3 },
      ),
    );
    expect(controller.inspector.view.getEntries().map((r) => r.seq)).toEqual([2, 1]);
    expect(controller.inspector.view.getModules()).toEqual(["todos", "trace"]);
    expect(controller.inspector.view.getDropped()).toBe(3);
    controller.inspector.view.setFilter({ level: "info" });
    expect(controller.inspector.view.getEntries().map((r) => r.seq)).toEqual([1]);
    controller.inspector.view.setFilter({ level: "trace", module: "trace" });
    expect(controller.inspector.view.getEntries().map((r) => r.seq)).toEqual([2]);
    controller.inspector.view.setFilter({ module: undefined });
    expect(
      controller.inspector.view.getFilter().module,
      "an undefined patch field leaves the value",
    ).toBe("trace");
    await controller.dispose();
  });

  it("dispose withdraws the backend and both panels", async () => {
    const { controller, slots } = boot({ total: 0, done: 0 });
    await controller.dispose();
    expect(slots.getSnapshot(loggerBackendsSlot)).toHaveLength(0);
    expect(slots.get(panelsSlot, "stats:overview")).toBeNull();
    expect(slots.get(panelsSlot, "logs:inspector")).toBeNull();
  });
});
