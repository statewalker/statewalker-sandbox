import { Commands } from "@statewalker/shared-commands";
// B0 bans a suite importing `@todo/ui` from also importing `@todo/core`
// directly (same precedent as `end-to-end.test.ts` and
// `dispose-liveness.test.ts`), hence the local seeded api below.
import { bootstrap, TodoListModel, uiShowList } from "@todo/app";
import { ViewAdapter } from "@todo/ui";
import { describe, expect, it } from "vitest";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const seededApi = () => {
  const rows = [{ id: "1", title: "seed", done: false }];
  return {
    list: async () => [...rows],
    add: async (title: string) => {
      const todo = { id: String(rows.length + 1), title, done: false };
      rows.push(todo);
      return todo;
    },
    toggle: async () => undefined,
    remove: async () => false,
    clearCompleted: async () => 0,
  };
};

/**
 * Task 12's own claim, tested against a REAL `ViewAdapter` rather than a
 * stand-in: `ListController.activate()` now makes the design's central
 * sentence true for the list — "a controller emits `ui:show-*(model)`; the
 * adapter claims it, renders, and unmounts when the command settles" — and
 * these are the three shapes that sentence has to hold in.
 */
describe("B4 · the list panel — shown by activate(), unmounted by dispose()/release()", () => {
  it("activate() shows exactly one list panel, reported by the adapter as ui:show-list", async () => {
    const commands = new Commands();
    let adapter: ViewAdapter | undefined;
    const mounted: unknown[] = [];
    const app = bootstrap({
      commands,
      api: seededApi(),
      registerViews: (bus) => {
        const views = new ViewAdapter(bus);
        // Claims by returning a cleanup and never calling settle() — a real
        // ListView's exact shape: long-lived, closed only by dispose().
        views.on(uiShowList, (view) => {
          mounted.push(view.model);
          return () => {};
        });
        adapter = views;
        return () => views.dispose();
      },
    });
    const model = new TodoListModel();
    app.createList(model);
    await tick();

    expect(adapter?.openViews().map((v) => v.key)).toEqual(["ui:show-list"]);
    expect(
      mounted,
      "the renderer actually ran, with the controller's own model as the payload",
    ).toEqual([model]);

    await app.dispose();
  });

  it("app.dispose() unmounts the list panel: the renderer's cleanup runs and openViews() empties", async () => {
    const commands = new Commands();
    let adapter: ViewAdapter | undefined;
    let cleanupRan = false;
    const app = bootstrap({
      commands,
      api: seededApi(),
      registerViews: (bus) => {
        const views = new ViewAdapter(bus);
        views.on(uiShowList, () => () => {
          cleanupRan = true;
        });
        adapter = views;
        return () => views.dispose();
      },
    });
    app.createList(new TodoListModel());
    await tick();
    expect(adapter?.openViews(), "precondition: the panel is open before teardown").toHaveLength(1);

    await app.dispose();

    expect(cleanupRan, "the renderer's own cleanup ran on unmount").toBe(true);
    expect(adapter?.openViews(), "the adapter no longer reports it as open").toEqual([]);
  });

  it("release() unmounts only its own controller's panel, leaving a sibling's untouched", async () => {
    const commands = new Commands();
    let adapter: ViewAdapter | undefined;
    const unmounted: string[] = [];
    const app = bootstrap({
      commands,
      api: seededApi(),
      registerViews: (bus) => {
        const views = new ViewAdapter(bus);
        let n = 0;
        views.on(uiShowList, () => {
          const id = `panel-${++n}`;
          return () => unmounted.push(id);
        });
        adapter = views;
        return () => views.dispose();
      },
    });
    const modelA = new TodoListModel();
    const modelB = new TodoListModel();
    const a = app.createList(modelA);
    const b = app.createList(modelB);
    await tick();
    expect(adapter?.openViews(), "precondition: both panels are open").toHaveLength(2);
    void b;

    await a.release();

    expect(unmounted, "only A's panel unmounted — release() must not touch B's").toEqual([
      "panel-1",
    ]);
    expect(
      adapter?.openViews().map((v) => v.model),
      "B's panel, and only B's, is still reported open",
    ).toEqual([modelB]);

    await app.dispose();
    expect(unmounted, "app.dispose() then unmounts the sibling too").toEqual([
      "panel-1",
      "panel-2",
    ]);
  });
});
