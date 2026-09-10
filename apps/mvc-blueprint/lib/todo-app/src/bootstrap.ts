import type { Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { type TodoApi, registerTodoCommands } from "@todo/core";
import { ListController } from "./list-controller.js";
import type { TodoListModel } from "./todo-model.js";

export interface BootstrapOptions {
  commands: Commands;
  api: TodoApi;
  /** Runs before any controller exists. The view layer registers its handlers here. */
  registerViews(commands: Commands): void;
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
 * handler is unambiguously a wiring bug rather than a startup race. Enforcing it
 * by comment is what fm-protos did, and nothing there prevents a controller
 * emitting before the view layer exists.
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
  // LIFO, so controllers are released before the view handlers, and the view
  // handlers before the command defaults — without anyone sequencing it.
  register(registerTodoCommands(commands, api));
  registerViews(commands);

  return {
    createList(model: TodoListModel): ListController {
      const controller = new ListController(model, commands, api);
      controller.activate();
      register(() => controller.dispose());
      return controller;
    },
    dispose: cleanup,
  };
}
