import { notifyUser } from "@notifications/commands";
import type { Commands } from "@statewalker/shared-commands";
import { getLogger, type Logger } from "@statewalker/shared-logger";
import { newRegistry } from "@statewalker/shared-registry";
import type { Slots } from "@statewalker/shared-slots";
import { type SubmitWatch, watchSubmits } from "@sys/action";
import { attempt } from "@sys/attempt";
import { type AppContext, getCommands, getSlots } from "@sys/context";
import { panelsSlot } from "@sys/extension-points";
import { newUpdateLoop, type UpdateLoop } from "@sys/update-loop";
import { getTodoApi, type TodoApi, type TodoPatch } from "@todos/core";
import { todosChanged } from "@todos/events";
import { todosEditOpen } from "./edit.commands.js";
import { createEditModel } from "./edit.model.impl.js";
import { type EditModel, type Todo, type TodoDraft, todoEditKind } from "./edit.model.js";

interface Services {
  readonly commands: Commands;
  readonly slots: Slots;
  readonly api: TodoApi;
  readonly log: Logger;
  readonly loop: UpdateLoop;
  readonly register: (release?: () => void | Promise<void>) => () => Promise<void>;
}

/**
 * What Save acts on, captured in the submit listener — not read again when
 * the pass reaches it. A draft the user changes after submitting, in the
 * same tick, must not retarget an already-submitted Save. The baseline is
 * the todo the draft was edited from: Save writes only what differs from it.
 */
interface SaveSnapshot {
  readonly baseline: Todo;
  readonly draft: TodoDraft;
}

/**
 * The fields the draft changed against its baseline, or undefined when none.
 * A field left out is not written, so a change made elsewhere while the
 * editor was open (the list ticking the todo) survives the Save.
 */
function changedFields({ baseline, draft }: SaveSnapshot): TodoPatch | undefined {
  const title = draft.title.trim();
  const patch: { title?: string; done?: boolean } = {};
  if (title !== baseline.title) patch.title = title;
  if (draft.done !== baseline.done) patch.done = draft.done;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

interface Session {
  readonly model: EditModel;
  readonly save: SubmitWatch;
  readonly cancel: SubmitWatch;
  readonly release: () => Promise<void>;
  /** The most recently submitted Save's snapshot, if any. */
  readonly getSaveSnapshot: () => SaveSnapshot | undefined;
}

/** The edit domain: answers `todos:edit:open` with an editor panel, and turns Save and Cancel into work. */
export class TodoEditController {
  private readonly _registry = newRegistry();
  private _disposed = false;
  private _services?: Services;
  private _session?: Session;
  private _opening: Promise<unknown> = Promise.resolve();
  /** The release promise of whichever close is currently in flight, if any — from any trigger. */
  private _closing?: Promise<void>;

  /** The open editor's model, if any. */
  get current(): EditModel | undefined {
    return this._session?.model;
  }

  activate(ctx: AppContext): void {
    if (this._services) throw new Error("TodoEditController already activated");
    const [register] = this._registry;
    const log = getLogger(ctx).child({ module: "todos.edit" });
    const loop = newUpdateLoop(() => this._pass(), {
      isDisposed: () => this._disposed,
      onError: (error) => log.error("update loop failed", { error: String(error) }),
    });
    const commands = getCommands(ctx);
    this._services = { commands, slots: getSlots(ctx), api: getTodoApi(ctx), log, loop, register };
    register(() => this._close());
    // Opens are serialised: each waits for the previous one, so two opens never race for the panel id.
    register(
      commands.listen(todosEditOpen, (cmd) => {
        const next = this._opening.then(() => this._open(cmd.payload.id));
        this._opening = next.catch(() => {});
        return next;
      }),
    );
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    const [, cleanup] = this._registry;
    await cleanup();
  }

  private async _open(id: string): Promise<{ opened: boolean }> {
    const services = this._services;
    if (!services || this._disposed) return { opened: false };
    const todo = (await services.api.list()).find((t) => t.id === id);
    if (this._disposed) return { opened: false };
    if (!todo) throw new Error(`todo not found: ${id}`);
    await this._close();
    // A close from elsewhere (Cancel or a successful Save, run from the
    // update loop) may still be releasing the previous panel registration
    // when this open reaches here — `_session` is already clear, so our own
    // `_close()` above was a no-op. Wait for that other close too, or the
    // keyed-slot register below collides with the not-yet-withdrawn entry.
    if (this._closing) await this._closing;
    if (this._disposed) return { opened: false };

    const model = createEditModel(todo);
    const [own, releaseAll] = newRegistry();
    own(() => model.dispose());
    try {
      own(
        services.slots.register(panelsSlot, "todos:edit", {
          kind: todoEditKind,
          title: `Edit "${todo.title}"`,
          placement: "side",
          model: model.view,
        }),
      );
    } catch (error) {
      // The registration failed (or anything registered before it in a future
      // change might): release what we already own rather than leak the new
      // model and its registry.
      void releaseAll();
      throw error;
    }
    // Read-only: this listener may read the model but must not write it. It
    // records what the user meant at submit time, so the pass acts on that —
    // not on whatever the draft holds once the microtask reaches it.
    let saveSnapshot: SaveSnapshot | undefined;
    own(
      model.control.actions.save.onSubmitsUpdate(() => {
        saveSnapshot = {
          baseline: model.view.details.getTodo(),
          draft: model.view.form.getDraft(),
        };
        services.loop.kick();
      }),
    );
    own(model.control.actions.cancel.onSubmitsUpdate(services.loop.kick));
    this._session = {
      model,
      save: watchSubmits(model.control.actions.save),
      cancel: watchSubmits(model.control.actions.cancel),
      release: services.register(releaseAll),
      getSaveSnapshot: () => saveSnapshot,
    };
    services.log.info("edit:opened", { id });
    return { opened: true };
  }

  private async _close(): Promise<void> {
    const session = this._session;
    if (!session) return;
    this._session = undefined;
    const closing = session.release();
    this._closing = closing;
    try {
      await closing;
    } finally {
      if (this._closing === closing) this._closing = undefined;
    }
  }

  private async _pass(): Promise<void> {
    const services = this._services;
    const session = this._session;
    if (!services || !session) return;
    const { model } = session;

    if (session.cancel.take()) {
      services.log.info("action:cancel", { id: model.view.details.getTodo().id });
      await this._close();
      return;
    }
    if (!session.save.take()) return;
    // `take()` only returns true after the submit listener ran and captured
    // a snapshot, so this fallback should be unreachable — but a consumed
    // Save must never be silently dropped for want of one.
    const snapshot = session.getSaveSnapshot() ?? {
      baseline: model.view.details.getTodo(),
      draft: model.view.form.getDraft(),
    };
    const { id } = snapshot.baseline;
    const patch = changedFields(snapshot);
    if (patch === undefined) {
      // Nothing differs from the baseline: saved already — nothing to write,
      // so nothing to broadcast, log or toast.
      await this._close();
      return;
    }

    const { save } = model.control.actions;
    model.control.reportError(undefined);
    save.update({ running: true });
    const result = await attempt(services.log, "save", () => services.api.update(id, patch));

    if (result.ok) {
      // The write already landed in the api: broadcast, log and toast it
      // regardless of whether this session is still current, so other
      // listeners (the list) see it. A disposed controller issues no command
      // at all (spec §9), so all three wait on that alone.
      if (!this._disposed) {
        services.log.info("action:save", { id });
        services.commands.call(todosChanged, { source: "todos.edit" });
        notifyUser(services.commands, services.log, { text: "Saved", level: "info" });
      }
    }

    if (this._disposed || this._session !== session) return;
    save.update({ running: false });
    if (!result.ok) {
      model.control.reportError(result.message);
      notifyUser(services.commands, services.log, { text: result.message, level: "error" });
      return;
    }
    model.control.markSaved(result.value);
    await this._close();
  }
}
