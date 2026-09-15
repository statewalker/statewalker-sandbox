import { notifyUser } from "@notifications/commands";
import type { Commands } from "@statewalker/shared-commands";
import { getLogger, type Logger } from "@statewalker/shared-logger";
import { newRegistry } from "@statewalker/shared-registry";
import type { Slots } from "@statewalker/shared-slots";
import { type SubmitWatch, watchSubmits } from "@sys/action";
import { attempt } from "@sys/attempt";
import { type AppContext, getCommands, getSlots } from "@sys/context";
import { dialogsSlot } from "@sys/extension-points";
import { newUpdateLoop, type UpdateLoop } from "@sys/update-loop";
import { getTodoApi, type TodoApi } from "@todos/core";
import { todosChanged } from "@todos/events";
import { todosClearCompletedAsk } from "./clear-completed.commands.js";
import { createConfirmModel } from "./clear-completed.model.impl.js";
import { type ConfirmModel, clearCompletedConfirmKind } from "./clear-completed.model.js";

interface Services {
  readonly commands: Commands;
  readonly slots: Slots;
  readonly api: TodoApi;
  readonly log: Logger;
  readonly loop: UpdateLoop;
  readonly register: (release?: () => void | Promise<void>) => () => Promise<void>;
}

interface Session {
  readonly model: ConfirmModel;
  /** The todos that were done when the question was asked — what OK removes. */
  readonly ids: readonly string[];
  readonly ok: SubmitWatch;
  readonly cancel: SubmitWatch;
  readonly release: () => Promise<void>;
}

const plural = (count: number) => `${count} completed todo${count === 1 ? "" : "s"}`;

/** The clear-completed domain: asks, returns at once, and acts on the answer when it comes. */
export class ClearCompletedController {
  private readonly _registry = newRegistry();
  private _disposed = false;
  private _services?: Services;
  private _session?: Session;

  get current(): ConfirmModel | undefined {
    return this._session?.model;
  }

  activate(ctx: AppContext): void {
    if (this._services) throw new Error("ClearCompletedController already activated");
    const [register] = this._registry;
    const log = getLogger(ctx).child({ module: "todos.clear-completed" });
    const loop = newUpdateLoop(() => this._pass(), {
      isDisposed: () => this._disposed,
      onError: (error) => log.error("update loop failed", { error: String(error) }),
    });
    const commands = getCommands(ctx);
    this._services = { commands, slots: getSlots(ctx), api: getTodoApi(ctx), log, loop, register };
    register(() => this._close());
    register(commands.listen(todosClearCompletedAsk, () => this._ask()));
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    const [, cleanup] = this._registry;
    await cleanup();
  }

  private async _ask(): Promise<{ asked: boolean }> {
    const services = this._services;
    if (!services || this._disposed) return { asked: false };
    if (this._session) return { asked: true };
    const ids = (await services.api.list()).filter((t) => t.done).map((t) => t.id);
    const count = ids.length;
    if (this._disposed || count === 0) return { asked: false };
    if (this._session) return { asked: true };

    const model = createConfirmModel({ text: `Delete ${plural(count)}?`, count });
    const [own, releaseAll] = newRegistry();
    own(() => model.dispose());
    own(
      services.slots.provide(dialogsSlot, { kind: clearCompletedConfirmKind, model: model.view }),
    );
    own(model.control.actions.ok.onSubmitsUpdate(services.loop.kick));
    own(model.control.actions.cancel.onSubmitsUpdate(services.loop.kick));
    this._session = {
      model,
      ids,
      ok: watchSubmits(model.control.actions.ok),
      cancel: watchSubmits(model.control.actions.cancel),
      release: services.register(releaseAll),
    };
    return { asked: true };
  }

  private async _close(): Promise<void> {
    const session = this._session;
    if (!session) return;
    this._session = undefined;
    await session.release();
  }

  private async _pass(): Promise<void> {
    const services = this._services;
    const session = this._session;
    if (!services || !session) return;
    if (session.cancel.take()) {
      await this._close();
      return;
    }
    if (!session.ok.take()) return;

    session.model.control.actions.ok.update({ running: true });
    // OK answers the question that was asked: it removes the todos that were
    // done then, not whatever is done now; one already gone is skipped.
    // Counted inside the work, not derived from the result: a failure
    // part-way through still leaves earlier removals in effect, and those
    // must be broadcast even though the overall attempt did not succeed.
    let removed = 0;
    const result = await attempt(services.log, "clear completed", async () => {
      for (const id of session.ids) {
        if (await services.api.remove(id)) removed++;
      }
    });
    if (this._disposed || this._session !== session) return;
    session.model.control.actions.ok.update({ running: false });
    if (removed > 0) {
      services.commands.call(todosChanged, { source: "todos.clear-completed" });
    }
    if (result.ok) {
      services.log.info("action:clear-completed", { count: removed });
      notifyUser(services.commands, services.log, {
        text: `Cleared ${plural(removed)}`,
        level: "info",
      });
    } else {
      notifyUser(services.commands, services.log, { text: result.message, level: "error" });
    }
    await this._close();
  }
}
