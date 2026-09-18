import { FsmProcess, KEY_DISPATCH, KEY_STATES, startProcess } from "@statewalker/fsm";
import { describe, expect, it, vi } from "vitest";

/**
 * Characterisation of `@statewalker/fsm` 0.38.1 as published — the behaviours that made
 * `@kit/machine` necessary. Each test pins what the library does today, not what we want.
 */
const chart = {
  key: "Editor",
  transitions: [
    ["", "*", "editing"],
    ["editing", "save", "saving"],
    ["saving", "ok", "done"],
  ] as [string, string, string][],
  states: [{ key: "editing" }, { key: "saving" }, { key: "done" }],
};

type Dispatch = (event: string) => Promise<void>;

describe("@statewalker/fsm 0.38.1, as published", () => {
  it("runner: the guard runs at CALL time, so a second same-tick event ends the whole machine", async () => {
    const ctx: Record<string, unknown> = {};
    await startProcess(ctx, chart, () => []);
    const dispatch = ctx[KEY_DISPATCH] as Dispatch;
    // Both pass the guard (the state is still `editing`); the second is processed in `saving`,
    // has no rule there, resolves to the final state and unwinds `saving` AND the root.
    await Promise.all([dispatch("save"), dispatch("save")]);
    expect(ctx[KEY_STATES]).toEqual([]);
  });

  it("engine: an event without a rule leaves the state (and here the root) instead of being ignored", async () => {
    const process = new FsmProcess(chart);
    await process.dispatch("");
    await process.dispatch("nonsense");
    expect(process.state).toBeUndefined();
  });

  it("runner: a generator's code after an await still runs after shutdown", async () => {
    const ctx: Record<string, unknown> = {};
    const writes: string[] = [];
    let release = () => {};
    const handle = await startProcess(ctx, chart, (key) =>
      key === "saving"
        ? [
            async function* () {
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              writes.push("written after shutdown");
              yield "ok";
            },
          ]
        : [],
    );
    await (ctx[KEY_DISPATCH] as Dispatch)("save");
    await handle.shutdown();
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writes).toEqual(["written after shutdown"]);
  });

  it("a throwing handler goes to console.error and the machine stays where it was", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx: Record<string, unknown> = {};
    await startProcess(ctx, chart, (key) =>
      key === "saving"
        ? [
            () => {
              throw new Error("boom");
            },
          ]
        : [],
    );
    await (ctx[KEY_DISPATCH] as Dispatch)("save");
    expect(ctx[KEY_STATES]).toEqual(["Editor", "saving"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("exit handlers of the left state run synchronously inside dispatch()", async () => {
    const log: string[] = [];
    const process = new FsmProcess(chart);
    process.onStateCreate((s) => {
      s.onExit(() => {
        log.push(`exit ${s.key}`);
      });
    });
    await process.dispatch("");
    const done = process.dispatch("save");
    log.push("dispatch returned");
    await done;
    expect(log).toEqual(["exit editing", "dispatch returned"]);
  });
});
