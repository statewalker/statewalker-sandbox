import type { Commands } from "@statewalker/shared-commands";
import { getLogger, type Logger } from "@statewalker/shared-logger";
import { newRegistry } from "@statewalker/shared-registry";
import { notifyUser } from "@notifications/commands";
import { type SubmitWatch, watchSubmits } from "@sys/action";
import { attempt } from "@sys/attempt";
import { type AppContext, getCommands, getSlots } from "@sys/context";
import {
  panelsSlot,
  todosSelectionActionsSlot,
  todosToolbarActionsSlot,
} from "@sys/extension-points";
import { newUpdateLoop, type UpdateLoop } from "@sys/update-loop";
import { todosClearCompletedAsk } from "@todos/clear-completed/commands";
import { getTodoApi, type TodoApi } from "@todos/core";
import { todosEditOpen } from "@todos/edit/commands";
import { todosChanged } from "@todos/events";
import { createTodoListModel } from "./list.model.impl.js";
import { type TodoListActions, type TodoListModel, todoListKind } from "./list.model.js";

type ActionKey = keyof TodoListActions<unknown>;
const ACTION_KEYS: readonly ActionKey[] = ["add", "toggle", "remove", "edit", "clearCompleted"];

interface Services {
  readonly commands: Commands;
  readonly api: TodoApi;
  readonly log: Logger;
  readonly loop: UpdateLoop;
  readonly watches: Readonly<Record<ActionKey, SubmitWatch>>;
}

/**
 * The todo list domain. Owns the list model and its five actions, contributes
 * the panel and the actions, and turns submitted intents into api calls and
 * commands — in one update loop, kicked by the actions' submit channels.
 */
export class TodoListController {
  private readonly _registry = newRegistry();
  private _disposed = false;
  private _model?: TodoListModel;
  private _services?: Services;
  private _reloadOwed = true;

  get model(): TodoListModel {
    if (!this._model) throw new Error("TodoListController is not activated");
    return this._model;
  }

  activate(ctx: AppContext): void {
    if (this._model) throw new Error("TodoListController already activated");
    const [register] = this._registry;
    const commands = getCommands(ctx);
    const slots = getSlots(ctx);
    const api = getTodoApi(ctx);
    const log = getLogger(ctx).child({ module: "todos.list" });

    const model = createTodoListModel();
    this._model = model;
    register(() => model.dispose());

    const loop = newUpdateLoop(() => this._pass(), {
      isDisposed: () => this._disposed,
      onError: (error) => log.error("update loop failed", { error: String(error) }),
    });
    const { actions } = model.control;
    const watches = Object.fromEntries(
      ACTION_KEYS.map((key) => [key, watchSubmits(actions[key])]),
    ) as Record<ActionKey, SubmitWatch>;
    this._services = { commands, api, log, loop, watches };

    for (const key of ACTION_KEYS) register(actions[key].onSubmitsUpdate(loop.kick));
    register(
      commands.listen(todosChanged, () => {
        this._reloadOwed = true;
        loop.kick();
      }),
    );

    const { view } = model;
    register(
      slots.register(panelsSlot, "todos:list", {
        kind: todoListKind,
        title: "Todos",
        placement: "main",
        model: view,
      }),
    );
    register(
      slots.provide(todosToolbarActionsSlot, {
        id: "todos.add",
        order: 10,
        action: view.actions.add,
      }),
    );
    register(
      slots.provide(todosToolbarActionsSlot, {
        id: "todos.clear-completed",
        order: 20,
        action: view.actions.clearCompleted,
      }),
    );
    register(
      slots.provide(todosSelectionActionsSlot, {
        id: "todos.toggle",
        order: 10,
        action: view.actions.toggle,
      }),
    );
    register(
      slots.provide(todosSelectionActionsSlot, {
        id: "todos.edit",
        order: 20,
        action: view.actions.edit,
      }),
    );
    register(
      slots.provide(todosSelectionActionsSlot, {
        id: "todos.remove",
        order: 30,
        action: view.actions.remove,
      }),
    );

    loop.kick(); // the initial load
  }

  /** Resolves once the update loop has nothing scheduled or running. */
  whenIdle(): Promise<void> {
    return this._services?.loop.idle() ?? Promise.resolve();
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    const [, cleanup] = this._registry;
    await cleanup();
  }

  /** One pass: every submitted intent, then the reload it made owed. Idempotent. */
  private async _pass(): Promise<void> {
    const services = this._services;
    const model = this._model;
    if (!services || !model) return;
    const { commands, api, log, watches } = services;
    const { view, control } = model;

    if (watches.add.take()) {
      const title = view.getNewTitle().trim();
      if (title !== "") {
        await this._run("add", `add "${title}"`, async () => {
          const todo = await api.add(title);
          control.clearNewTitle();
          log.info("action:add", { id: todo.id });
        });
      }
    }
    if (watches.toggle.take()) {
      const selected = new Set(view.getSelection());
      const targets = view.getItems().filter((t) => selected.has(t.id));
      await this._run("toggle", "toggle", async () => {
        for (const todo of targets) await api.update(todo.id, { done: !todo.done });
        log.info("action:toggle", { ids: targets.map((t) => t.id) });
      });
    }
    if (watches.remove.take()) {
      const ids = [...view.getSelection()];
      await this._run("remove", "delete", async () => {
        for (const id of ids) await api.remove(id);
        log.info("action:remove", { ids });
      });
    }
    if (watches.edit.take()) {
      const [id] = view.getSelection();
      if (id !== undefined) {
        await this._run(
          "edit",
          "open the editor",
          async () => {
            await commands.call(todosEditOpen, { id }).promise;
          },
          false,
        );
      }
    }
    if (watches.clearCompleted.take()) {
      await this._run(
        "clearCompleted",
        "clear completed",
        async () => {
          await commands.call(todosClearCompletedAsk, {}).promise;
        },
        false,
      );
    }

    if (this._reloadOwed && !this._disposed) {
      this._reloadOwed = false;
      const loaded = await attempt(log, "load todos", () => api.list());
      if (this._disposed) return;
      if (loaded.ok) {
        control.replaceItems(loaded.value);
      } else {
        control.reportOutcome(loaded.message);
        notifyUser(commands, log, { text: loaded.message, level: "error" });
      }
    }
  }

  /** Runs one intent: `running` while it runs; a failure becomes the outcome and an error toast. */
  private async _run(
    key: ActionKey,
    what: string,
    work: () => Promise<void>,
    reload = true,
  ): Promise<void> {
    const services = this._services;
    const model = this._model;
    if (!services || !model || this._disposed) return;
    const action = model.control.actions[key];
    action.update({ running: true });
    const result = await attempt(services.log, what, work);
    if (this._disposed) return;
    action.update({ running: false });
    if (result.ok) {
      model.control.reportOutcome(undefined);
    } else {
      model.control.reportOutcome(result.message);
      notifyUser(services.commands, services.log, { text: result.message, level: "error" });
      if ((result.error as { kind?: unknown } | undefined)?.kind === "no-handlers")
        action.update({ enabled: false });
    }
    if (reload) this._reloadOwed = true;
  }
}
