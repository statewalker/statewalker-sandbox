import { LogsController } from "@logs/app";
import { Command } from "@statewalker/shared-commands";
import { getLogger } from "@statewalker/shared-logger";
import { type InspectorView, StatsController, StatsModel } from "@stats/app";
import {
  type AppContext,
  defineViewKind,
  loggerBackendsSlot,
  panelsSlot,
  setCommands,
  setSlots,
} from "@sys";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TracingCommands, TracingSlots, traceModel } from "../../src/tracing.js";
import { settle } from "../support/context.js";
import { newRecordingLogger } from "../support/logging.js";

const demoEcho = Command.required("demo:echo")
  .input(z.object({ v: z.number() }))
  .output(z.object({ v: z.number() }))
  .build();

const traces = (calls: { args: unknown[]; metadata: Record<string, unknown> }[]) =>
  calls
    .filter((c) => c.metadata.module === "trace")
    .map((c) => ({ event: c.args[0], data: c.args[1] }));

describe("B2 · tracing", () => {
  it("TracingCommands logs each call and how it settled", async () => {
    const recorder = newRecordingLogger();
    const commands = new TracingCommands(() => recorder.logger);
    commands.listen(demoEcho, async (cmd) => ({ v: cmd.payload.v }));
    await commands.call(demoEcho, { v: 1 }).promise;
    const orphan = Command.required("demo:orphan").input(z.object({})).output(z.object({})).build();
    await commands.call(orphan, {}).promise.catch(() => {});
    await settle(2);
    expect(traces(recorder.calls)).toEqual([
      { event: "command:call", data: { key: "demo:echo" } },
      { event: "command:settled", data: { key: "demo:echo", ok: true, ms: expect.any(Number) } },
      { event: "command:call", data: { key: "demo:orphan" } },
      {
        event: "command:settled",
        data: { key: "demo:orphan", ok: false, ms: expect.any(Number), error: expect.any(String) },
      },
    ]);
  });

  it("TracingSlots logs provide and dispose — once — and traces only ui:* models", () => {
    const recorder = newRecordingLogger();
    const slots = new TracingSlots(() => recorder.logger);
    const kind = defineViewKind<StatsModel["view"]>("stats:overview");
    const stats = new StatsModel();
    const off = slots.register(panelsSlot, "p", {
      kind,
      title: "S",
      placement: "side",
      model: stats.view,
    });
    const backend = { write: () => {} };
    const offBackend = slots.provide(loggerBackendsSlot, backend);
    expect(slots.get(panelsSlot, "p")?.model, "a ui:* model is replaced by a traced copy").not.toBe(
      stats.view,
    );
    expect(slots.getSnapshot(loggerBackendsSlot)[0], "a sys:* contribution is untouched").toBe(
      backend,
    );
    off();
    off();
    offBackend();
    expect(traces(recorder.calls).map((t) => t.event)).toEqual([
      "slot:provide",
      "slot:provide",
      "slot:dispose",
      "slot:dispose",
    ]);
  });

  it("a traced model delegates every member and logs each delivery on its channels", () => {
    const recorder = newRecordingLogger();
    const stats = new StatsModel();
    const traced = traceModel(
      stats.view,
      { slot: "ui:panels", kind: "stats:overview" },
      () => recorder.logger,
    );
    let heard = 0;
    traced.onBucketUpdate(() => {
      heard++;
    });
    traced.setBucket(60_000);
    expect(traced.getBucket()).toBe(60_000);
    expect(heard, "immediate call + one change").toBe(2);
    expect(recorder.calls.filter((c) => c.args[0] === "model:notify")).toHaveLength(2);
    expect(recorder.calls[0].args[1]).toEqual({
      slot: "ui:panels",
      kind: "stats:overview",
      channel: "onBucketUpdate",
    });
  });

  it("tracing the log inspector's own notifications terminates, and the suppressed records are counted", async () => {
    const ctx: AppContext = {};
    const slots = new TracingSlots(() => getLogger(ctx));
    setSlots(ctx, slots);
    setCommands(ctx, new TracingCommands(() => getLogger(ctx)));
    const logs = new LogsController({ fallback: newRecordingLogger().logger });
    logs.activate(ctx);
    const stats = new StatsController({ tickMs: 60_000 });
    stats.activate(ctx);
    await settle();
    const inspector = slots.get(panelsSlot, "logs:inspector")?.model as InspectorView;
    let deliveries = 0;
    inspector.onEntriesUpdate(() => {
      deliveries++;
    });
    getLogger(ctx).child({ module: "demo" }).info("hello");
    getLogger(ctx).child({ module: "demo" }).info("again");
    expect(inspector.getEntries().map((r) => r.args[0])).toEqual(
      expect.arrayContaining(["hello", "again"]),
    );
    expect(deliveries, "no runaway re-delivery").toBeLessThan(20);
    expect(
      inspector.getDropped(),
      "the traced notifications during delivery were dropped",
    ).toBeGreaterThan(0);
    await stats.dispose();
    await logs.dispose();
  });
});
