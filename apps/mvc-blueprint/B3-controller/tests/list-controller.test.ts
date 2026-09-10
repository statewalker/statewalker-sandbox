import { Commands } from "@statewalker/shared-commands";
import { beforeEach, describe, expect, it } from "vitest";
import { MemTodoApi, type Todo } from "@todo/core";
import {
  type AppHandle,
  ListController,
  TodoListModel,
  bootstrap,
  expectCoalescedEdge,
  expectNoSelfWake,
} from "@todo/app";


const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A `TodoApi` whose `list()` throws while `failing` is set — the backend going away. */
class FlakyTodoApi extends MemTodoApi {
  failing = false;
  override async list() {
    if (this.failing) {
      this.calls.push("list");
      await Promise.resolve();
      throw new Error("network down");
    }
    return super.list();
  }
}

/** A `TodoApi` whose `list()` takes `ms` to answer — a real network, not a microtask. */
class SlowTodoApi extends MemTodoApi {
  /** Calls entered and not yet answered. */
  outstanding = 0;
  constructor(
    rows: Todo[],
    private readonly _ms: number,
  ) {
    super(rows);
  }
  override async list() {
    this.outstanding++;
    try {
      const rows = await super.list();
      await new Promise((r) => setTimeout(r, this._ms));
      return rows;
    } finally {
      this.outstanding--;
    }
  }
}

/**
 * Runs `body` with a process-level `unhandledRejection` listener attached. A
 * controller firing `void this._reconcile()` has nowhere to send a rejection
 * but here — which is exactly the leak these tests exist to catch.
 */
async function collectingUnhandled(body: (unhandled: unknown[]) => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await body(unhandled);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("B3 · list controller", () => {
  let commands: Commands;
  let api: MemTodoApi;
  let model: TodoListModel;
  let controller: ListController;
  let app: AppHandle;

  beforeEach(() => {
    commands = new Commands();
    api = new MemTodoApi([{ id: "1", title: "seed", done: false }]);
    // Routed through bootstrap() — the honest way to obtain an activated
    // controller — rather than `new ListController(...).activate()` directly,
    // which now refuses without the token bootstrap mints (see B4's
    // bootstrap.test.ts "refuses to activate").
    app = bootstrap({ commands, api, registerViews: () => {} });
    model = new TodoListModel();
    controller = app.createList(model);
  });

  it("loads the api into the model on activate", async () => {
    await tick();
    expect(model.todos.map((t) => t.id)).toEqual(["1"]);
  });

  it("drains the pending queue, one todo per queued item", async () => {
    await tick();
    model.input.queueSubmit("a");
    model.input.queueSubmit("b");
    await tick();
    await tick();
    expect(model.todos.map((t) => t.title)).toEqual(["seed", "a", "b"]);
    expect(model.input.pending, "the queue must be replaced with [] on drain").toEqual([]);
  });

  it("coalesces refresh: two increments in one tick are one reload", async () => {
    await tick();
    expectCoalescedEdge({
      bump: () => model.input.requestRefresh(),
      read: () => model.input.refreshCount,
      actions: () => controller.debug.reloads,
      label: "refreshCount",
    });
  });

  it("folds every bump arriving mid-flight into ONE follow-up carrying the newest state", async () => {
    await tick();
    const before = controller.debug.reloads;
    // Five bumps with no gap. Without coalescing this is five reloads; with
    // leading+trailing coalescing it is exactly two — the one already running,
    // and one follow-up that sees the newest count.
    for (let i = 0; i < 5; i++) model.input.requestRefresh();
    await tick();
    await tick();
    expect(controller.debug.reloads - before).toBe(2);
  });

  it("does not wake itself when it writes the outer model", async () => {
    await tick();
    await expectNoSelfWake({
      reactions: () => controller.debug.reactions,
      writeOuter: () =>
        model.replaceTodos([...model.todos, { id: "9", title: "by controller", done: false }]),
      writeInput: () => model.input.requestRefresh(),
    });
  });

  it("is not woken by a level change it does not subscribe to", async () => {
    await tick();
    const before = controller.debug.reactions;
    model.input.setFilter("anything");
    await tick();
    expect(controller.debug.reactions, "filtering is view state, not a reload").toBe(before);
  });

  it("writes outcomes to the OUTER model, so live typing is never wiped", async () => {
    await tick();
    model.input.setFilter("half-typed");
    let outcomes = 0;
    model.onOutcomeChange(() => {
      outcomes++;
    });
    model.input.queueSubmit(""); // todos:add's schema is min(1): the bus rejects it
    await tick();
    await tick();
    expect(outcomes, "the controller must report through the outer model's mutator").toBe(1);
    expect(model.lastOutcome).toMatch(/^add "" failed: input-validation/);
    expect(model.input.filterDraft, "and the input sub-model is left alone").toBe("half-typed");
  });

  describe("error policy — a failure becomes an outcome, never a lost promise", () => {
    it("surfaces a rejected add: no hang, no unhandled rejection, and the controller lives on", async () => {
      await collectingUnhandled(async (unhandled) => {
        await tick();
        model.input.queueSubmit(""); // rejected by todosAdd's zod `min(1)`
        await tick();
        await tick();
        expect(model.lastOutcome, "the rejection must reach the user").toMatch(/input-validation: todos:add/);
        expect(model.input.pending, "the item was taken off the queue, not wedged in it").toEqual([]);
        expect(unhandled, "a `void`ed reconcile must not leak its rejection").toEqual([]);

        // Alive: the next submission is handled, and a later successful pass
        // replaces the stale failure rather than leaving it on screen forever.
        model.input.queueSubmit("next");
        await tick();
        await tick();
        expect(model.todos.map((t) => t.title)).toEqual(["seed", "next"]);
        expect(model.lastOutcome, "a pass that fully succeeded clears the outcome").toBeUndefined();
        expect(unhandled).toEqual([]);
      });
    });

    it("reports a failed load and stays retryable by ONE bump", async () => {
      await collectingUnhandled(async (unhandled) => {
        const flaky = new FlakyTodoApi([{ id: "1", title: "seed", done: false }]);
        flaky.failing = true;
        const flakyApp = bootstrap({ commands: new Commands(), api: flaky, registerViews: () => {} });
        const m = new TodoListModel();
        flakyApp.createList(m);
        await tick();
        await tick();
        expect(m.todos, "nothing loaded").toEqual([]);
        expect(m.lastOutcome, "and the user is told why").toBe("reload failed: network down");
        expect(unhandled, "the failed load must not escape as a rejection").toEqual([]);

        flaky.failing = false;
        m.input.requestRefresh(); // exactly one bump — nothing unmotivated
        await tick();
        await tick();
        expect(m.todos.map((t) => t.id)).toEqual(["1"]);
        expect(m.lastOutcome, "the retry succeeded, so the failure is no longer true").toBeUndefined();
        await flakyApp.dispose();
      });
    });

    it("does not count a failed refresh as handled — the next pass redoes it unasked", async () => {
      // The watermark must move only once the reload has LANDED. Advanced
      // before the await, it claims a reload that threw was done: the refresh
      // is then owed but never repaid, until the user happens to bump again.
      const flaky = new FlakyTodoApi([{ id: "1", title: "seed", done: false }]);
      const flakyApp = bootstrap({ commands: new Commands(), api: flaky, registerViews: () => {} });
      const m = new TodoListModel();
      const c = flakyApp.createList(m);
      await tick();

      flaky.failing = true;
      m.input.requestRefresh();
      await tick();
      await tick();
      expect(m.lastOutcome).toBe("reload failed: network down");

      // Recover, then wake the controller through the OTHER edge. No refresh
      // bump: the refresh it still owes must be repaid on its own.
      flaky.failing = false;
      const before = c.debug.reloads;
      m.input.queueSubmit("x");
      await tick();
      await tick();
      expect(
        c.debug.reloads - before,
        "one reload for the add, and one repaying the refresh that failed",
      ).toBe(2);
      await flakyApp.dispose();
    });
  });

  it("is quiescent: once dispose() resolves, the controller never writes the model again", async () => {
    // `ViewAdapter.dispose()` was fixed for exactly this asymmetry; the
    // controller never got it. Unsubscribing stops NEW work, but the reload
    // already awaiting the api still lands ~60ms later, on a model whose owner
    // has been told teardown is complete.
    const slow = new SlowTodoApi([{ id: "1", title: "seed", done: false }], 60);
    const slowApp = bootstrap({ commands: new Commands(), api: slow, registerViews: () => {} });
    const m = new TodoListModel();
    slowApp.createList(m); // the initial load is now in flight
    let writes = 0;
    m.onUpdate(() => {
      writes++; // raw: ANY write counts — the list, or an outcome
    });
    expect(slow.outstanding, "precondition: the load is in flight").toBe(1);
    await slowApp.dispose();
    // Two separate properties, two assertions. Waiting the run out is what
    // makes dispose() mean "done"; the disposed flag is what stops the waited-
    // out run from writing. Either alone passes one of these and fails the other.
    expect(slow.outstanding, "dispose() resolved with the controller's api call still in flight").toBe(0);
    const atDispose = writes;
    await new Promise((r) => setTimeout(r, 120));
    expect(writes, "a write landed after dispose() resolved").toBe(atDispose);
    expect(m.todos, "the in-flight load was dropped, not applied late").toEqual([]);
  });

  it("refuses a second activate(), which would double-subscribe every channel", async () => {
    // Replays the GENUINE token bootstrap handed this controller — captured on
    // its way in, never minted — because since B4's token fix no caller holds
    // one otherwise. bootstrap re-uses one token for every controller by
    // design, so replay is the realistic way a second activate() happens.
    const original = ListController.prototype.activate;
    let token: unknown;
    ListController.prototype.activate = function (this: ListController, ready) {
      token = ready;
      return original.call(this, ready);
    };
    let again: ListController;
    try {
      again = app.createList(new TodoListModel());
    } finally {
      ListController.prototype.activate = original;
    }
    expect(token, "captured the real token").toBeDefined();
    expect(() => again.activate(token as never)).toThrow(/already activated/);
  });

  it("stops reacting after dispose", async () => {
    await tick();
    const before = controller.debug.reactions;
    await controller.dispose();
    model.input.requestRefresh();
    await tick();
    expect(controller.debug.reactions).toBe(before);
  });
});
