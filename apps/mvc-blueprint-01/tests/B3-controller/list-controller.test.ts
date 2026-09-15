import { CommandError, Commands } from "@statewalker/shared-commands";
import {
  type AppHandle,
  bootstrap,
  createTodoListModel,
  expectCoalescedEdge,
  expectNoSelfWake,
  ListController,
  type TodoListModel,
  uiConfirm,
} from "@todo/app";
import { MemTodoApi, type Todo } from "@todo/core";
import { beforeEach, describe, expect, it } from "vitest";
import { watch, watchResults } from "../support/signals.js";
import { answerDialogs, claimListView, type Dialogs } from "../support/views.js";

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
    app = bootstrap({ commands, api, registerViews: (bus) => claimListView(bus) });
    model = createTodoListModel();
    controller = app.createList(model).controller;
  });

  it("loads the api into the model on activate", async () => {
    await tick();
    expect(model.control.todos().map((t) => t.id)).toEqual(["1"]);
  });

  it("drains the pending queue, one todo per queued item", async () => {
    await tick();
    model.view.queueSubmit("a");
    model.view.queueSubmit("b");
    await tick();
    await tick();
    expect(model.control.todos().map((t) => t.title)).toEqual(["seed", "a", "b"]);
    expect(model.control.edges.pending(), "the queue must be replaced with [] on drain").toEqual([]);
  });

  it("coalesces refresh: two increments in one tick are one reload", async () => {
    await tick();
    expectCoalescedEdge({
      bump: () => model.view.requestRefresh(),
      read: () => model.control.edges.refreshCount(),
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
    for (let i = 0; i < 5; i++) model.view.requestRefresh();
    await tick();
    await tick();
    expect(controller.debug.reloads - before).toBe(2);
  });

  it("does not wake itself when it writes the outer model", async () => {
    await tick();
    await expectNoSelfWake({
      reactions: () => controller.debug.reactions,
      writeOuter: () =>
        model.control.replaceTodos([...model.control.todos(), { id: "9", title: "by controller", done: false }]),
      writeInput: () => model.view.requestRefresh(),
    });
  });

  it("is not woken by a level change it does not subscribe to", async () => {
    await tick();
    const before = controller.debug.reactions;
    model.view.setFilter("anything");
    await tick();
    expect(controller.debug.reactions, "filtering is view state, not a reload").toBe(before);
  });

  it("tracks its edges and nothing else — the clear-completed check's read of the list subscribes nothing", async () => {
    // That check reads `control.todos()` in the synchronous prefix of
    // `_reconcile`, which runs inside the controller's effect. Untracked, the
    // read subscribes nothing. Tracked, every later result write would wake
    // the controller — its own writes included.
    const bus = new Commands();
    const dialogs = answerDialogs(bus, false); // decline: nothing is cleared
    const local = bootstrap({
      commands: bus,
      api: new MemTodoApi([{ id: "1", title: "seed", done: true }]),
      registerViews: (b) => claimListView(b),
    });
    const m = createTodoListModel();
    const c = local.createList(m).controller;
    await tick();
    m.view.requestClearCompleted();
    await tick();
    await tick();
    expect(dialogs.confirms, "precondition: the pass that read the list ran").toEqual(["Clear 1 completed todo?"]);
    const before = c.debug.reactions;
    m.control.replaceTodos([{ id: "2", title: "x", done: false }]);
    expect(c.debug.reactions, "a result write woke the controller").toBe(before);
    dialogs.off();
    await local.dispose();
  });

  it("writes outcomes to the OUTER model, so live typing is never wiped", async () => {
    await tick();
    model.view.setFilter("half-typed");
    const outcomes = watch(model.view.lastOutcome);
    model.view.queueSubmit(""); // todos:add's schema is min(1): the bus rejects it
    await tick();
    await tick();
    expect(outcomes.n, "the controller must report through the outer model's mutator").toBe(1);
    expect(model.view.lastOutcome()).toMatch(/^add "" failed: input-validation/);
    expect(model.view.filterDraft(), "and the input sub-model is left alone").toBe("half-typed");
  });

  describe("error policy — a failure becomes an outcome, never a lost promise", () => {
    it("surfaces a rejected add: no hang, no unhandled rejection, and the controller lives on", async () => {
      await collectingUnhandled(async (unhandled) => {
        await tick();
        model.view.queueSubmit(""); // rejected by todosAdd's zod `min(1)`
        await tick();
        await tick();
        expect(model.view.lastOutcome(), "the rejection must reach the user").toMatch(
          /input-validation: todos:add/,
        );
        expect(model.control.edges.pending(), "the item was taken off the queue, not wedged in it").toEqual(
          [],
        );
        expect(unhandled, "a `void`ed reconcile must not leak its rejection").toEqual([]);

        // Alive: the next submission is handled, and a later successful pass
        // replaces the stale failure rather than leaving it on screen forever.
        model.view.queueSubmit("next");
        await tick();
        await tick();
        expect(model.control.todos().map((t) => t.title)).toEqual(["seed", "next"]);
        expect(model.view.lastOutcome(), "a pass that fully succeeded clears the outcome").toBeUndefined();
        expect(unhandled).toEqual([]);
      });
    });

    it("reports a failed load and stays retryable by ONE bump", async () => {
      await collectingUnhandled(async (unhandled) => {
        const flaky = new FlakyTodoApi([{ id: "1", title: "seed", done: false }]);
        flaky.failing = true;
        const flakyApp = bootstrap({
          commands: new Commands(),
          api: flaky,
          registerViews: (bus) => claimListView(bus),
        });
        const m = createTodoListModel();
        flakyApp.createList(m);
        await tick();
        await tick();
        expect(m.control.todos(), "nothing loaded").toEqual([]);
        expect(m.view.lastOutcome(), "and the user is told why").toBe("reload failed: network down");
        expect(unhandled, "the failed load must not escape as a rejection").toEqual([]);

        flaky.failing = false;
        m.view.requestRefresh(); // exactly one bump — nothing unmotivated
        await tick();
        await tick();
        expect(m.control.todos().map((t) => t.id)).toEqual(["1"]);
        expect(
          m.view.lastOutcome(),
          "the retry succeeded, so the failure is no longer true",
        ).toBeUndefined();
        await flakyApp.dispose();
      });
    });

    it("does not count a failed refresh as handled — the next pass redoes it unasked", async () => {
      // The watermark must move only once the reload has LANDED. Advanced
      // before the await, it claims a reload that threw was done: the refresh
      // is then owed but never repaid, until the user happens to bump again.
      const flaky = new FlakyTodoApi([{ id: "1", title: "seed", done: false }]);
      const flakyApp = bootstrap({
        commands: new Commands(),
        api: flaky,
        registerViews: (bus) => claimListView(bus),
      });
      const m = createTodoListModel();
      const c = flakyApp.createList(m).controller;
      await tick();

      flaky.failing = true;
      m.view.requestRefresh();
      await tick();
      await tick();
      expect(m.view.lastOutcome()).toBe("reload failed: network down");

      // Recover, then wake the controller through the OTHER edge. No refresh
      // bump: the refresh it still owes must be repaid on its own.
      flaky.failing = false;
      const before = c.debug.reloads;
      m.view.queueSubmit("x");
      await tick();
      await tick();
      expect(
        c.debug.reloads - before,
        "one reload for the add, and one repaying the refresh that failed",
      ).toBe(2);
      await flakyApp.dispose();
    });
  });

  it("is WRITE-quiescent: once dispose() resolves, no model write lands, even when the api answers later", async () => {
    // dispose() no longer waits for the in-flight run to finish — waiting
    // deadlocks whenever that run awaits something only the view layer
    // settles, and bootstrap's LIFO teardown releases controllers before
    // views (see dispose-liveness.test.ts). So dispose() may now resolve
    // WHILE the controller's reload is still awaiting the slow api. What
    // must still hold is the weaker guarantee: `_disposed`, set first and
    // checked after every await, makes that run drop its write instead of
    // landing on a model whose owner was told teardown is complete.
    const slow = new SlowTodoApi([{ id: "1", title: "seed", done: false }], 60);
    const slowApp = bootstrap({
      commands: new Commands(),
      api: slow,
      registerViews: (bus) => claimListView(bus),
    });
    const m = createTodoListModel();
    slowApp.createList(m); // the initial load is now in flight
    const writes = watchResults(m); // the list, or an outcome
    expect(slow.outstanding, "precondition: the load is in flight").toBe(1);
    await slowApp.dispose();
    const atDispose = writes.n;
    // The slow api is still outstanding here: dispose() did not wait it out.
    // It is left to answer on its own — and when it does, the write must not land.
    await new Promise((r) => setTimeout(r, 120));
    expect(slow.outstanding, "the api call was allowed to finish on its own").toBe(0);
    expect(writes.n, "a write landed after dispose() resolved").toBe(atDispose);
    expect(m.control.todos(), "the in-flight load's answer was dropped, not applied late").toEqual([]);
  });

  it("refuses a second activate(), which would subscribe a second effect", async () => {
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
      again = app.createList(createTodoListModel()).controller;
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
    model.view.requestRefresh();
    await tick();
    expect(controller.debug.reactions).toBe(before);
  });

  describe("the panel command — Command.required's actual case", () => {
    // Deliberately the ONE place in this file that does NOT use
    // `claimListView`: this is what `Command.required` exists to catch, and
    // it must fail loudly rather than vanish.
    it("fails loudly with no-handlers when no uiShowList handler is registered, and leaks no unhandled rejection", async () => {
      await collectingUnhandled(async (unhandled) => {
        const bareApp = bootstrap({
          commands: new Commands(),
          api: new MemTodoApi([{ id: "1", title: "seed", done: false }]),
          registerViews: () => {}, // no uiShowList handler — the wiring bug
        });
        const m = createTodoListModel();
        const c = bareApp.createList(m).controller;

        const result = await c.panelSettled;
        expect(result.ok, "the panel command must reject, not hang or silently succeed").toBe(
          false,
        );
        if (!result.ok) {
          expect(result.error, "the same CommandError the bus itself produces").toBeInstanceOf(
            CommandError,
          );
          expect((result.error as CommandError).kind).toBe("no-handlers");
          expect((result.error as CommandError).commandKey).toBe("ui:show-list");
        }

        // Not folded into reportOutcome: a later successful load must NOT
        // erase the record of the wiring bug the way it erases a transient
        // failure. This is exactly why `reportOutcome` was the wrong channel.
        await tick();
        await tick();
        expect(
          m.control.todos().map((t) => t.id),
          "the list itself still loads fine",
        ).toEqual(["1"]);
        const resultAfterSuccess = await c.panelSettled;
        expect(
          resultAfterSuccess.ok,
          "the wiring bug does not go away because an unrelated load succeeded",
        ).toBe(false);

        expect(unhandled, "no unhandled rejection, whether or not panelSettled is read").toEqual(
          [],
        );
        await bareApp.dispose();
      });
    });

    it("never produces an unhandled rejection even when nobody reads panelSettled", async () => {
      await collectingUnhandled(async (unhandled) => {
        const bareApp = bootstrap({
          commands: new Commands(),
          api: new MemTodoApi(),
          registerViews: () => {},
        });
        bareApp.createList(createTodoListModel());
        // No one ever touches `.panelSettled` here — the guarantee must not
        // depend on a caller opting in.
        await tick();
        await tick();
        expect(unhandled).toEqual([]);
        await bareApp.dispose();
      });
    });
  });
});

/** A `TodoApi` whose `clearCompleted()` waits until the suite opens `gate`. */
class GatedClearApi extends MemTodoApi {
  private _open!: () => void;
  readonly gate = new Promise<void>((r) => {
    this._open = r;
  });
  release(): void {
    this._open();
  }
  /** Clears entered and still waiting on the gate. */
  waiting = 0;
  override async clearCompleted(): Promise<number> {
    this.waiting++;
    await this.gate;
    this.waiting--;
    return super.clearCompleted();
  }
}

/** A `TodoApi` whose `clearCompleted()` is refused by the backend. */
class RefusingClearApi extends MemTodoApi {
  override async clearCompleted(): Promise<number> {
    this.calls.push("clearCompleted");
    await Promise.resolve();
    throw new Error("backend refused");
  }
}

/** A `TodoApi` whose `remove()` is refused by the backend. */
class RefusingRemoveApi extends MemTodoApi {
  override async remove(): Promise<boolean> {
    this.calls.push("remove");
    await Promise.resolve();
    throw new Error("backend refused");
  }
}

/**
 * The row intents (Task 13a). Two EVENT edges — toggle and remove, each a
 * replaced queue carrying the id — and one STATE-LATEST edge, clear-completed,
 * which orchestrates the spec §5 chain: a short-lived view (confirm), a
 * command, and a fire-and-forget view (notify).
 */
describe("B3 · list controller — row intents", () => {
  const boot = (rows: Todo[], answer: Dialogs["answer"] = true, api = new MemTodoApi(rows)) => {
    let dialogs!: Dialogs;
    const app = bootstrap({
      commands: new Commands(),
      api,
      registerViews: (bus) => {
        const off = claimListView(bus);
        dialogs = answerDialogs(bus, answer);
        return () => {
          dialogs.off();
          off();
        };
      },
    });
    const model = createTodoListModel();
    const controller = app.createList(model).controller;
    return { api, app, model, controller, dialogs };
  };
  const row = (id: string, done = false): Todo => ({ id, title: `todo ${id}`, done });
  const settle = async () => {
    for (let i = 0; i < 4; i++) await tick();
  };

  describe("toggle and remove — EVENT edges: N presses are N actions", () => {
    it("two requestToggle in one tick toggle BOTH todos", async () => {
      const { api, app, model } = boot([row("1"), row("2")]);
      await settle();
      model.view.requestToggle("1");
      model.view.requestToggle("2");
      await settle();
      expect(model.control.todos().map((t) => t.done), "neither toggle was lost").toEqual([true, true]);
      expect(api.calls.filter((c) => c === "toggle")).toHaveLength(2);
      expect(model.control.edges.toggles(), "the queue is drained by replacement").toEqual([]);
      expect(model.view.lastOutcome()).toBeUndefined();
      await app.dispose();
    });

    it("two toggles on ONE row in one tick are a round trip, not one toggle", async () => {
      // The sharpest proof the edge is an EVENT edge: a state-latest reading
      // would coalesce these into one toggle and leave the row done.
      const { api, app, model } = boot([row("1")]);
      await settle();
      model.view.requestToggle("1");
      model.view.requestToggle("1");
      await settle();
      expect(api.calls.filter((c) => c === "toggle")).toHaveLength(2);
      expect(model.control.todos().map((t) => t.done)).toEqual([false]);
      await app.dispose();
    });

    it("two requestRemove in one tick delete BOTH todos", async () => {
      const { api, app, model } = boot([row("1"), row("2"), row("3")]);
      await settle();
      model.view.requestRemove("1");
      model.view.requestRemove("3");
      await settle();
      expect(model.control.todos().map((t) => t.id)).toEqual(["2"]);
      expect(api.calls.filter((c) => c === "remove")).toHaveLength(2);
      expect(model.control.edges.removals()).toEqual([]);
      await app.dispose();
    });

    it("toggle and remove of the SAME row in one tick: the row is gone, nothing reported — in every order", async () => {
      // Two orders are in play, and this pins both. The FIRST press on an idle
      // controller starts the run synchronously, so it goes out first — press
      // order. Presses that arrive while a run is in flight pile up and drain
      // BY TYPE — adds, toggles, removes — whatever order they were pressed in.
      // Either way the end state is the one the user asked for: a deleted row
      // is gone. What makes this safe is the `TodoApi` contract, not luck:
      // `toggle()` of a missing row answers `undefined` (the core maps it to
      // `{ done: false }`) and `remove()` of one answers `false` — neither is
      // an error — so a toggle that meets an already-deleted row is a no-op,
      // never a confusing "toggle failed" for a row the user just deleted.
      const cases = [
        {
          name: "idle, toggle then remove",
          busy: false,
          press: (m: TodoListModel) => {
            m.view.requestToggle("1");
            m.view.requestRemove("1");
          },
          sent: ["toggle", "remove"],
        },
        {
          name: "idle, remove then toggle — the first press leads",
          busy: false,
          press: (m: TodoListModel) => {
            m.view.requestRemove("1");
            m.view.requestToggle("1"); // meets a deleted row: a no-op
          },
          sent: ["remove", "toggle"],
        },
        {
          name: "busy, remove then toggle — drained by type",
          busy: true,
          press: (m: TodoListModel) => {
            m.view.requestRemove("1");
            m.view.requestToggle("1");
          },
          sent: ["toggle", "remove"],
        },
      ];
      for (const c of cases) {
        const { api, app, model } = boot([row("1"), row("2")]);
        await settle();
        if (c.busy) model.view.requestRefresh(); // a run is now in flight
        c.press(model);
        await settle();
        expect(model.control.todos().map((t) => t.id), `${c.name}: the deleted row is gone`).toEqual(["2"]);
        expect(model.view.lastOutcome(), `${c.name}: nothing failed`).toBeUndefined();
        expect(
          api.calls.filter((call) => call === "toggle" || call === "remove"),
          `${c.name}: the order the commands went out`,
        ).toEqual(c.sent);
        await app.dispose();
      }
    });

    it("a failing todos:remove is reported via lastOutcome — no unhandled rejection, and the controller lives on", async () => {
      await collectingUnhandled(async (unhandled) => {
        const { app, model } = boot([row("1"), row("2")], true, new RefusingRemoveApi([row("1"), row("2")]));
        await settle();
        model.view.requestRemove("2");
        await settle();
        expect(model.view.lastOutcome(), "the refusal must reach the user").toMatch(
          /^remove "2" failed: listener-threw: todos:remove/,
        );
        expect(model.control.todos().map((t) => t.id), "nothing was removed").toEqual(["1", "2"]);
        expect(model.control.edges.removals(), "taken off the queue, not wedged in it").toEqual([]);
        expect(unhandled, "a `void`ed reconcile must not leak its rejection").toEqual([]);

        model.view.requestToggle("1");
        await settle();
        expect(model.control.todos()[0]?.done, "the next intent is still handled").toBe(true);
        expect(model.view.lastOutcome(), "and a clean pass clears the stale failure").toBeUndefined();
        expect(unhandled).toEqual([]);
        await app.dispose();
      });
    });
  });

  describe("clear-completed — a STATE-LATEST edge through confirm, command, notify", () => {
    it("two requestClearCompleted in one tick open ONE confirm dialog", async () => {
      const { api, app, model, dialogs } = boot([row("1", true), row("2")]);
      await settle();
      model.view.requestClearCompleted();
      model.view.requestClearCompleted();
      await settle();
      // The COUNT of dialogs, not the end state: a controller that asked twice
      // reaches the same list.
      expect(dialogs.confirms, "two quick presses are one question").toEqual([
        "Clear 1 completed todo?",
      ]);
      expect(api.calls.filter((c) => c === "clearCompleted")).toHaveLength(1);
      expect(dialogs.notifies).toEqual(["Cleared 1 completed todo"]);
      await app.dispose();
    });

    it("confirmed: clears, then notifies with the count the COMMAND returned, then reloads", async () => {
      const api = new MemTodoApi([row("1", true), row("2"), row("3")]);
      const { app, model, dialogs } = boot([], true, api);
      await settle();
      // The backend moves behind the model's back: the model still believes
      // one todo is completed, the backend has two. The question can only
      // quote the model; the notify must quote what was actually cleared.
      await api.toggle("3");
      model.view.requestClearCompleted();
      await settle();
      expect(dialogs.confirms).toEqual(["Clear 1 completed todo?"]);
      expect(dialogs.notifies, "the count comes from the command's result").toEqual([
        "Cleared 2 completed todos",
      ]);
      expect(model.control.todos().map((t) => t.id), "and the list was reloaded").toEqual(["2"]);
      expect(model.view.lastOutcome()).toBeUndefined();
      await app.dispose();
    });

    it("declined: nothing cleared, no notify — and the answer is final, not owed", async () => {
      const { api, app, model, dialogs } = boot([row("1", true), row("2")], false);
      await settle();
      model.view.requestClearCompleted();
      await settle();
      expect(dialogs.confirms).toHaveLength(1);
      expect(api.calls, "no clear was attempted").not.toContain("clearCompleted");
      expect(dialogs.notifies).toEqual([]);
      expect(model.control.todos().map((t) => t.id)).toEqual(["1", "2"]);

      // The user answered, so the watermark moved: a pass woken by any other
      // edge must not ask again.
      model.view.requestRefresh();
      await settle();
      expect(dialogs.confirms, "a declined request is not re-asked").toHaveLength(1);
      await app.dispose();
    });

    it("presses while the dialog is open fold into its answer; a press after the answer earns ONE follow-up", async () => {
      const api = new GatedClearApi([row("1", true), row("2", true), row("3")]);
      const { app, model, dialogs } = boot([], "hold", api);
      await settle();
      model.view.requestClearCompleted();
      await settle();
      expect(dialogs.held, "the dialog is open").toBe(1);
      // Pressed again while it is open — not in the same tick, a real wait.
      model.view.requestClearCompleted();
      model.view.requestClearCompleted();
      await settle();
      expect(dialogs.confirms, "an open dialog already asks the newest question").toHaveLength(1);

      dialogs.answer = true; // any follow-up answers at once
      dialogs.answerHeld(true);
      await tick();
      expect(api.waiting, "precondition: the answer landed and the clear is in flight").toBe(1);
      // Pressed after the answer, while the clear is in flight: that is a new
      // request the open dialog never covered, so it must not be lost. Row 3
      // is completed meanwhile, so the follow-up has something to ask about
      // (an empty question is skipped — see "nothing completed" below).
      model.view.requestToggle("3");
      model.view.requestClearCompleted();
      model.view.requestClearCompleted();
      api.release();
      await settle();
      expect(dialogs.confirms, "leading + trailing: the first dialog, and ONE follow-up").toEqual([
        "Clear 2 completed todos?",
        "Clear 1 completed todo?",
      ]);
      expect(api.calls.filter((c) => c === "clearCompleted")).toHaveLength(2);
      expect(dialogs.notifies).toEqual(["Cleared 2 completed todos", "Cleared 1 completed todo"]);
      expect(model.control.todos()).toEqual([]);
      await app.dispose();
    });

    it("words the question and the toast in the singular for 1, the plural for more", async () => {
      const one = boot([row("1", true), row("2")]);
      await settle();
      one.model.view.requestClearCompleted();
      await settle();
      expect(one.dialogs.confirms).toEqual(["Clear 1 completed todo?"]);
      expect(one.dialogs.notifies).toEqual(["Cleared 1 completed todo"]);
      await one.app.dispose();

      const three = boot([row("1", true), row("2", true), row("3", true), row("4")]);
      await settle();
      three.model.view.requestClearCompleted();
      await settle();
      expect(three.dialogs.confirms).toEqual(["Clear 3 completed todos?"]);
      expect(three.dialogs.notifies).toEqual(["Cleared 3 completed todos"]);
      await three.app.dispose();
    });

    it("nothing completed: no question, no command, no toast, no model write — and the press is consumed", async () => {
      // Decided in the CONTROLLER, not left to a view disabling its button: a
      // host or an agent can raise this intent too, and asking any of them
      // "Clear 0 completed todos?" is a question with no content.
      const { api, app, model, dialogs } = boot([row("1"), row("2")]);
      await settle();
      const writes = watchResults(model); // the list, or an outcome
      model.view.requestClearCompleted();
      await settle();
      expect(dialogs.confirms).toEqual([]);
      expect(dialogs.notifies).toEqual([]);
      expect(api.calls).not.toContain("clearCompleted");
      expect(writes.n, "a skipped question writes nothing — no reload, no outcome").toBe(0);
      expect(model.view.lastOutcome()).toBeUndefined();

      // Consumed, not owed: once a todo IS completed, the pass that toggle
      // wakes must not ask on the skipped press's behalf.
      model.view.requestToggle("1");
      await settle();
      expect(model.control.todos()[0]?.done).toBe(true);
      expect(dialogs.confirms, "the skipped press is not replayed by an unrelated edge").toEqual([]);
      model.view.requestClearCompleted();
      await settle();
      expect(dialogs.confirms, "a real press now has something to ask").toEqual([
        "Clear 1 completed todo?",
      ]);
      await app.dispose();
    });

    it("a clear that fails AFTER the user confirmed is reported and answered — an unrelated toggle does not re-ask", async () => {
      // The user's intent was consumed by their answer. Re-asking would
      // re-prompt someone who already said yes, on whatever edge next wakes
      // the loop. They retry explicitly, by pressing again.
      await collectingUnhandled(async (unhandled) => {
        const api = new RefusingClearApi([row("1", true), row("2")]);
        const { app, model, dialogs } = boot([], true, api);
        await settle();
        model.view.requestClearCompleted();
        await settle();
        expect(dialogs.confirms).toHaveLength(1);
        expect(model.view.lastOutcome()).toMatch(
          /^clear completed failed: listener-threw: todos:clear-completed/,
        );
        expect(dialogs.notifies, "nothing was cleared, so nothing is announced").toEqual([]);

        model.view.requestToggle("2");
        await settle();
        expect(model.control.todos()[1]?.done, "the toggle itself was handled").toBe(true);
        expect(dialogs.confirms, "an answered question is never re-asked unprompted").toHaveLength(1);

        model.view.requestClearCompleted(); // the explicit retry
        await settle();
        expect(dialogs.confirms, "pressing again asks again").toHaveLength(2);
        expect(unhandled).toEqual([]);
        await app.dispose();
      });
    });

    it("with no notify view registered: the clear still lands, the missing toast is reported, nothing unhandled", async () => {
      // The notify is fire-and-forget — never awaited — yet a dispatch-time
      // failure must not vanish: it rejects synchronously inside call(), and
      // the run folds it into its outcome once the reload returns.
      await collectingUnhandled(async (unhandled) => {
        const api = new MemTodoApi([row("1", true), row("2")]);
        const app = bootstrap({
          commands: new Commands(),
          api,
          registerViews: (bus) => {
            const offList = claimListView(bus);
            const offConfirm = bus.listen(uiConfirm, () => Promise.resolve({ confirmed: true }));
            return () => {
              offConfirm();
              offList();
            };
          },
        });
        const model = createTodoListModel();
        app.createList(model);
        await settle();
        model.view.requestClearCompleted();
        await settle();
        expect(model.control.todos().map((t) => t.id), "the clear landed and the list reloaded").toEqual(["2"]);
        expect(model.view.lastOutcome()).toMatch(/^notify failed: .*no-handlers/);
        expect(unhandled).toEqual([]);
        await app.dispose();
      });
    });

    it("with no confirm view registered: reported, nothing cleared, no unhandled rejection", async () => {
      await collectingUnhandled(async (unhandled) => {
        const api = new MemTodoApi([row("1", true)]);
        const app = bootstrap({
          commands: new Commands(),
          api,
          registerViews: (bus) => claimListView(bus), // the list, but no dialogs
        });
        const model = createTodoListModel();
        app.createList(model);
        await settle();
        model.view.requestClearCompleted();
        await settle();
        expect(model.view.lastOutcome()).toMatch(/^confirm failed: .*no-handlers/);
        expect(api.calls).not.toContain("clearCompleted");
        expect(unhandled).toEqual([]);
        await app.dispose();
      });
    });
  });
});
