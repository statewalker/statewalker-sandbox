import { Commands } from "@statewalker/shared-commands";
// A suite that spans every layer on purpose. B0's "views know only models" rule
// binds todo-ui SOURCES and the suites that render views; this one takes the
// view layer only as its headless adapter, so it runs over the real api.
import { bootstrap, createTodoListModel, MenuController, uiShowMenu } from "@todo/app";
import { ViewAdapter } from "@todo/ui/adapter";
import { describe, expect, it } from "vitest";
import { seededApi } from "../support/api.js";
import { claimListView } from "../support/views.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Spec §1.1: "Views are command handlers. A controller emits `ui:show-*(model)`;
 * the adapter claims it, renders, and unmounts when the command settles — from
 * either side." Every other suite demonstrates a half of that: bootstrap is
 * tested with `registerViews: () => {}`, and the adapter with `commands.call`
 * written by the test. Nothing ran the sentence itself. This does, with no
 * stand-in between the production pieces.
 */
describe("B4 · end to end — bus, then views, then controllers, nothing faked between", () => {
  it("renders a controller's ui: command in a real view, and unmounts it on settle and on dispose", async () => {
    const commands = new Commands();
    const mounted: string[] = [];
    const unmounted: string[] = [];
    let adapter: ViewAdapter | undefined;
    // What the "user" does with the next menu: pick one of its keys, or leave it open.
    let user: ((keys: string[]) => string) | "leaves-it-open" = (keys) => keys[1] ?? "";

    const app = bootstrap({
      commands,
      api: seededApi(),
      // The production shape of `registerViews`: install a ViewAdapter on the
      // bus, bind a renderer per declaration, hand the adapter's dispose back
      // so it joins bootstrap's registry.
      registerViews: (bus) => {
        const views = new ViewAdapter(bus);
        // Claimed on the raw bus, NOT mounted on `views`: this test asserts
        // on `views.openViews()` for the MENU, and the list panel — claimed,
        // never settled until the controller's own dispose() — would sit in
        // that same map forever if it were mounted on this adapter instead.
        const unclaimList = claimListView(bus);
        views.on(uiShowMenu, (view) => {
          mounted.push(`menu:${view.model.items.map((i) => i.label).join("|")}`);
          const act = user;
          if (act !== "leaves-it-open") {
            // A click arrives after the menu has painted — later, not during render.
            setTimeout(
              () => view.settle({ selectedKey: act(view.model.items.map((i) => i.key)) }),
              0,
            );
          }
          return () => unmounted.push("menu");
        });
        adapter = views;
        return async () => {
          unclaimList();
          await views.dispose();
        };
      },
    });
    const model = createTodoListModel();
    app.createList(model);
    await tick();
    expect(
      model.control.todos().map((t) => t.id),
      "the list controller came up through the same bootstrap",
    ).toEqual(["1"]);

    // 1. The user settles it: the controller's command renders a view with the
    //    labels the controller copied in, the choice travels back, and the view
    //    unmounts because its command settled.
    const menu = new MenuController(commands);
    const picked = await menu.openFor(["1"]);
    expect(mounted).toEqual(["menu:Add|Toggle|Delete|Clear completed"]);
    expect(picked, "the view's result reaches the controller").toBe("todos:toggle");
    expect(unmounted, "the view unmounts when its command settles").toEqual(["menu"]);
    expect(adapter?.openViews()).toEqual([]);

    // 2. Still open at teardown: the app's dispose unwinds the view layer, which
    //    unmounts the view and rejects the controller's pending call rather than
    //    leaving it awaiting a view that no longer exists.
    user = "leaves-it-open";
    const pending = menu.openFor(["1"]).then(
      () => undefined,
      (e: Error) => e,
    );
    await tick();
    expect(
      adapter?.openViews().map((v) => v.key),
      "identified by its command key",
    ).toEqual(["ui:show-menu"]);
    expect(unmounted).toEqual(["menu"]);

    await app.dispose();
    expect(unmounted, "the view unmounts when the app disposes").toEqual(["menu", "menu"]);
    expect((await pending)?.message).toMatch(/disposed/);
  });
});
