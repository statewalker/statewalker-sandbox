import type { Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { type TodoApi, registerTodoCommands } from "@todo/core";
import { ListController } from "./list-controller.js";
import type { TodoListModel } from "./todo-model.js";
import { ViewsReady } from "./views-ready.js";

export interface BootstrapOptions {
  commands: Commands;
  api: TodoApi;
  /**
   * Runs before any controller can be activated. The view layer registers its
   * handlers here. May return a cleanup — sync or async, same shape as any
   * other registration — which joins the same registry as everything else, so
   * it unwinds in the same LIFO order as the rest of bootstrap's teardown. A
   * caller with nothing to release may return nothing.
   */
  registerViews(commands: Commands): void | (() => void | Promise<void>);
}

export interface AppHandle {
  createList(model: TodoListModel): ListController;
  /** The registry's cleanup: LIFO, idempotent, error-tolerant. */
  dispose(): Promise<void>;
}

/**
 * Bus -> view handlers -> controllers, made structural rather than documented.
 *
 * The ordering is what makes `Command.required` correct everywhere: a missing
 * handler is unambiguously a wiring bug rather than a startup race. Enforcing
 * it by comment is what fm-protos did, and nothing there prevented a
 * controller emitting before the view layer existed.
 *
 * "Structural" means more than "this function happens to call things in the
 * right order": `registerViews` runs and returns before `ViewsReady._mint()`
 * is ever called, and `ListController.activate()` refuses to run without a
 * genuine `ViewsReady` — a token only this function can produce. That closes
 * the gap a plain call order leaves open, where any caller with access to
 * `ListController` (a test, a future host) could construct and activate one
 * without the view layer ever having registered a handler.
 *
 * The capability — not "construct every controller here" — is the shape that
 * generalises: the Files Manager creates and disposes panel controllers as
 * panels come and go, and the dock shell loads mini-apps at run time. Both need
 * to create controllers AFTER bootstrap returned, and both still need the order.
 */
export function bootstrap(options: BootstrapOptions): AppHandle {
  const { commands, api, registerViews } = options;
  const [register, cleanup] = newRegistry();

  // Registration order IS the teardown order, reversed: the registry unwinds
  // LIFO, so controllers (registered later, via createList) are released
  // before the view handlers, and the view handlers before the command
  // defaults — without anyone sequencing it.
  register(registerTodoCommands(commands, api));
  const viewsCleanup = registerViews(commands);
  if (viewsCleanup) register(viewsCleanup);

  // Minted only now, once the view layer is provably done registering: no
  // controller created below this line can predate it.
  const ready = ViewsReady._mint();

  return {
    createList(model: TodoListModel): ListController {
      const controller = new ListController(model, commands, api);
      controller.activate(ready);
      register(() => controller.dispose());
      return controller;
    },
    dispose: cleanup,
  };
}
