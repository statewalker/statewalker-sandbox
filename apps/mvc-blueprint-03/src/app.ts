import { NotificationsController } from "@notifications";
import { Commands } from "@statewalker/shared-commands";
import { getLogger } from "@statewalker/shared-logger";
import { newRegistry } from "@statewalker/shared-registry";
import { Slots } from "@statewalker/shared-slots";
import { type AppContext, setCommands, setSlots } from "@sys/context";
import { ClearCompletedController } from "@todos/clear-completed";
import { MemTodoApi, setTodoApi, type Todo, type TodoApi } from "@todos/core";
import { TodoEditController } from "@todos/edit";
import { TodoListController } from "@todos/list";
import { mountReactHost, observeCoverage, type Unrendered } from "@ui/host";
import { notificationRenderers } from "@ui/notifications";
import { clearCompletedRenderers } from "@ui/todos/clear-completed";
import { todoEditRenderers } from "@ui/todos/edit";
import { todoListRenderers } from "@ui/todos/list";
import { createLayout } from "./layout.js";

export interface StartOptions {
  readonly api?: TodoApi;
  readonly notificationTimeoutMs?: number;
  readonly onUnrendered?: (unrendered: Unrendered) => void;
}

export interface RunningApp {
  readonly context: AppContext;
  dispose(): Promise<void>;
}

export const seedTodos: readonly Todo[] = Object.freeze([
  { id: "t1", title: "Read MODELS.md", done: true },
  { id: "t2", title: "Try the context menu on a row", done: false },
  { id: "t3", title: "Edit a todo and save it", done: false },
]);

/**
 * The composition root — the only module that sets the context's services and
 * wires controllers to the UI host. Disposal is LIFO through one registry.
 */
export function startApp(root: HTMLElement, options: StartOptions = {}): RunningApp {
  const context: AppContext = {};
  const [register, cleanup] = newRegistry();

  setCommands(context, new Commands());
  const slots = new Slots();
  setSlots(context, slots);
  setTodoApi(context, options.api ?? new MemTodoApi(seedTodos));

  const regions = createLayout(root);
  register(() => root.replaceChildren());

  const controllers = [
    new NotificationsController({ timeoutMs: options.notificationTimeoutMs }),
    new TodoEditController(),
    new ClearCompletedController(),
    new TodoListController(),
  ];
  for (const controller of controllers) {
    controller.activate(context);
    register(() => controller.dispose());
  }

  const host = mountReactHost({
    slots,
    regions: { main: regions.main, side: regions.side },
    dialogs: regions.dialogs,
    notifications: regions.notifications,
    renderers: [
      ...todoListRenderers,
      ...todoEditRenderers,
      ...clearCompletedRenderers,
      ...notificationRenderers,
    ],
  });
  register(() => host.dispose());

  const uiLog = getLogger(context).child({ module: "ui" });
  register(
    observeCoverage(slots, [host], (unrendered) => {
      console.warn("[mvc-blueprint-03] no host renders", unrendered);
      uiLog.warn("ui:unrendered", unrendered);
      options.onUnrendered?.(unrendered);
    }),
  );

  let disposed = false;
  return {
    context,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await cleanup();
    },
  };
}
