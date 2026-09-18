import { describe, expect, it } from "vitest";
import { clearCompletedChart } from "../../src/bundles/todos.clear-completed/machine.js";
import { drive, trace } from "./trace.js";

describe("todos.clear-completed chart (no DOM, no kernel)", () => {
  it("ask → confirm → done; a second ask while busy is refused", async () => {
    const { machine, log } = await trace(clearCompletedChart);
    expect(await drive(machine, "ask", "ask", "confirm", "ask", "done")).toEqual([
      "todos.clear-completed/busy/asking",
      "todos.clear-completed/busy/asking",
      "todos.clear-completed/busy/clearing",
      "todos.clear-completed/busy/clearing",
      "todos.clear-completed/idle",
    ]);
    expect(log.filter((l) => l.startsWith("+busy"))).toHaveLength(1);
  });

  it("cancel from asking; confirm is not an answer once idle", async () => {
    const { machine } = await trace(clearCompletedChart);
    expect(await drive(machine, "ask", "cancel", "confirm")).toEqual([
      "todos.clear-completed/busy/asking",
      "todos.clear-completed/idle",
      "todos.clear-completed/idle",
    ]);
  });
});

describe("todos.clear-completed chart, answers sent by `asking`", () => {
  it("confirm and cancel in one tick: the first answer wins, the second dies with `asking`", async () => {
    const { startMachine } = await import("@kit/machine");
    const { newRecordingLogger } = await import("../support/logging.js");
    let answer: ((e: string) => void) | undefined;
    const machine = startMachine(
      clearCompletedChart,
      {
        busy: () => ({
          states: {
            asking: ({ send }) => {
              answer = send;
            },
          },
        }),
      },
      { log: newRecordingLogger().logger, name: "t" },
    );
    machine.send("ask");
    await machine.idle();
    answer?.("confirm");
    answer?.("cancel");
    await machine.idle();
    expect(machine.states()).toEqual(["todos.clear-completed", "busy", "clearing"]);
  });
});
