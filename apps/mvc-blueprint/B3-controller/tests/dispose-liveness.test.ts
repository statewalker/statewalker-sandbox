import { Command, Commands } from "@statewalker/shared-commands";
import { bootstrap, ConfirmModel, TodoListModel, uiConfirm } from "@todo/app";
import { ViewAdapter } from "@todo/ui";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mountListView } from "../../test-support/views.js";

/**
 * B0 bans a suite that imports `@todo/ui` from also importing `@todo/core`
 * directly (`boundaries.test.ts`, "holds for todo-ui SUITES too") — the same
 * reason B4's `end-to-end.test.ts` hand-rolls a `seededApi()` instead of
 * importing `MemTodoApi`. This suite needs both a real `ViewAdapter` and a way
 * to override `todos:add`, so it does the same: a local seeded api, and a
 * local declaration matching `todos:add` only by KEY (dispatch in
 * `@statewalker/shared-commands` routes listeners by `decl.key`, a string —
 * never by object identity — so this reaches the exact same bus event the
 * real `@todo/core` `todosAdd` names, without naming the core package here).
 */
const seededApi = () => {
  let rows = [{ id: "1", title: "seed", done: false }];
  return {
    list: async () => [...rows],
    add: async (title: string) => {
      const todo = { id: String(rows.length + 1), title, done: false };
      rows = [...rows, todo];
      return todo;
    },
    toggle: async () => undefined,
    remove: async () => false,
    clearCompleted: async () => 0,
  };
};

const localTodosAdd = Command.required("todos:add")
  .input(z.object({ title: z.string().min(1) }))
  .output(z.object({ id: z.string() }))
  .build();

/**
 * The canonical deadlock `declarations.ts` advertises: a host routes
 * `todos:add` through an approval dialog. The dialog is a `ui:` command the
 * VIEW LAYER settles — never the controller. `bootstrap`'s registry unwinds
 * LIFO, so `createList`'s controller (registered last) is disposed BEFORE
 * `registerViews`'s cleanup (registered first). If the controller's
 * `dispose()` waits for its in-flight run to finish, and that run is stuck
 * awaiting a confirm the view layer alone can settle, the view layer that
 * COULD unstick it (by rejecting the still-open command on its own dispose)
 * never gets torn down — because tearing it down is exactly what is being
 * waited on. `app.dispose()` hangs forever.
 *
 * This suite boots the real `ViewAdapter` from `@todo/ui`, installs a
 * `ui:show-dialog:confirm` renderer that claims and never settles, overrides
 * `todos:add` at priority 0 to await that confirm, and drives a submit so the
 * controller's run is genuinely stuck on it — then asserts `app.dispose()`
 * resolves anyway, racing it against a bound that FAILS the test instead of
 * hanging the runner.
 */
describe("B3 · dispose() liveness — a controller stuck on a view-settled command must not deadlock teardown", () => {
  it("app.dispose() resolves within bound even while a controller's run awaits an unsettled confirm dialog", async () => {
    const commands = new Commands();
    let confirmCleanupRan = false;

    const app = bootstrap({
      commands,
      api: seededApi(),
      // The production shape: install a real ViewAdapter, bind a renderer,
      // hand its dispose back so it joins bootstrap's LIFO registry — same
      // pattern as B4's end-to-end suite, plus the host override that makes
      // `todos:add` route through the dialog.
      registerViews: (bus) => {
        const views = new ViewAdapter(bus);
        mountListView(views);
        views.on(uiConfirm, () => {
          // Claims by returning a cleanup, and never calls `settle()` — the
          // dialog is left open, exactly as the scenario requires.
          return () => {
            confirmCleanupRan = true;
          };
        });
        // A host override at priority 0 beats the core's negative-priority
        // default (B2's command-surface suite), and awaits the confirm
        // before ever resolving the add.
        bus.listen(
          localTodosAdd,
          async () => {
            await bus.call(uiConfirm, new ConfirmModel("Add this todo?")).promise;
            return { id: "host" };
          },
          { priority: 0 },
        );
        return () => views.dispose();
      },
    });

    const model = new TodoListModel();
    app.createList(model);
    // Queues the add: the controller's `_reconcile()` run is now genuinely
    // stuck awaiting the confirm that will never settle.
    model.input.queueSubmit("x");
    await new Promise((r) => setTimeout(r, 0)); // let the run actually reach the await

    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 500);
    });
    const disposed = app.dispose().then(() => "disposed" as const);
    const result = await Promise.race([disposed, timeout]);

    expect(
      result,
      "app.dispose() must resolve even though the controller has a run stuck awaiting a view-settled command",
    ).toBe("disposed");
    expect(
      confirmCleanupRan,
      "the still-open confirm view must be torn down by the view layer's OWN dispose, once teardown reaches it",
    ).toBe(true);
  });

  it("app.dispose() resolves while the controller's OWN clear-completed confirm is open", async () => {
    // Task 13a: the controller itself now awaits a view-settled command —
    // `uiConfirm`, from `requestClearCompleted()` — with no host override
    // involved. Same deadlock shape as above, reached by an ordinary button:
    // if dispose() ever waits on in-flight work again, this hangs.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const commands = new Commands();
      let views!: ViewAdapter;
      let confirmCleanupRan = false;
      let clearCalls = 0;
      const api = { ...seededApi(), clearCompleted: async () => ++clearCalls };
      const app = bootstrap({
        commands,
        api,
        registerViews: (bus) => {
          views = new ViewAdapter(bus);
          mountListView(views);
          views.on(uiConfirm, () => () => {
            confirmCleanupRan = true; // claims; never settles
          });
          return () => views.dispose();
        },
      });

      const model = new TodoListModel();
      app.createList(model);
      await new Promise((r) => setTimeout(r, 0)); // the initial load lands
      model.input.requestClearCompleted();
      await new Promise((r) => setTimeout(r, 0));
      expect(
        views.openViews().map((v) => v.key),
        "precondition: the confirm is open and the run is awaiting it",
      ).toContain("ui:show-dialog:confirm");

      let writes = 0;
      model.onUpdate(() => {
        writes++; // raw: ANY model write after teardown began
      });
      const timeout = new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 500);
      });
      const disposed = app.dispose().then(() => "disposed" as const);
      expect(await Promise.race([disposed, timeout]), "dispose must not wait on the open confirm").toBe(
        "disposed",
      );
      await new Promise((r) => setTimeout(r, 0)); // let the rejected confirm unwind the run
      expect(confirmCleanupRan, "the view layer's own dispose closed the dialog").toBe(true);
      expect(views.openViews()).toEqual([]);
      expect(clearCalls, "the open question was never answered, so nothing was cleared").toBe(0);
      expect(writes, "the force-rejected confirm must not land a write (e.g. an outcome)").toBe(0);
      expect(unhandled, "the force-rejected confirm is caught inside the run").toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
