/**
 * `todos.clear-completed` — answers `todos:clear-completed:ask`: shows a confirm dialog, then removes
 * the todos that were done WHEN ASKED (captured in the ask), and notifies how many it removed.
 */
import {
  type Behavior,
  type BundleManifest,
  type Contributed,
  contribute,
  defineStream,
} from "../../kernel/index.js";
import { newNotifier } from "../../kit/notify.js";
import { type Dialog, dialogs, menu } from "../shell/api/index.js";
import {
  type ClearCompletedMsg,
  type ClearCompletedState,
  clearCompletedKind,
  collection,
  todosClearCompleted,
  todosCore,
  toolbarActions,
} from "../todos/api/index.js";

const view = defineStream<ClearCompletedState>("todos.clear-completed:view");

export function todosClearCompletedBundle(
  options: { notifyTimeoutMs?: number } = {},
): BundleManifest {
  const behavior: Behavior<ClearCompletedMsg> = (ctx) => {
    const notifier = newNotifier(ctx, options.notifyTimeoutMs);
    let doneIds: readonly string[] = [];
    let asked:
      | { ids: readonly string[]; running: boolean; dialog: Contributed<Dialog> }
      | undefined;
    const action = () => ({
      id: "clear-completed",
      label: "Clear completed",
      enabled: doneIds.length > 0 && !asked,
      to: todosClearCompleted,
      msg: { type: "todos:clear-completed:ask" },
    });
    const toolbar = contribute(ctx, toolbarActions, "todos.clear-completed", {
      order: 20,
      action: action(),
    });
    const menuItem = contribute(ctx, menu, "todos.clear-completed", {
      group: "todos",
      groupLabel: "Todos",
      order: 10,
      action: action(),
    });
    const refresh = () => {
      toolbar.update({ order: 20, action: action() });
      menuItem.update({ group: "todos", groupLabel: "Todos", order: 10, action: action() });
      if (!asked) return;
      ctx.publish(view, {
        count: asked.ids.length,
        confirm: {
          id: "confirm",
          label: "Clear",
          enabled: !asked.running,
          running: asked.running,
          to: todosClearCompleted,
          msg: { type: "confirm" },
        },
        cancel: {
          id: "cancel",
          label: "Cancel",
          enabled: !asked.running,
          to: todosClearCompleted,
          msg: { type: "cancel" },
        },
      });
    };
    ctx.subscribe(collection, (c) => {
      doneIds = (c?.todos ?? []).filter((t) => t.done).map((t) => t.id);
      refresh();
    });
    const closeDialog = () => {
      asked?.dialog.withdraw();
      asked = undefined;
      refresh();
    };

    return (msg, env) => {
      if (notifier.handle(msg)) return;
      switch (msg.type) {
        case "todos:clear-completed:ask": {
          if (asked) return env.ok();
          const ids = doneIds;
          const dialog = contribute(ctx, dialogs, "todos:clear-completed", {
            kind: clearCompletedKind.id,
            stream: view,
            inbox: todosClearCompleted,
            title: "Clear completed",
          });
          asked = { ids, running: false, dialog };
          refresh();
          return env.ok();
        }
        case "cancel":
          if (asked && !asked.running) closeDialog();
          return;
        case "confirm": {
          const a = asked;
          if (!a || a.running) return;
          a.running = true;
          refresh();
          ctx.pipe(
            ctx.ask(todosCore, { type: "todos:remove", ids: a.ids }),
            (n) => {
              if (asked === a) closeDialog();
              notifier.notify(`Cleared ${n} completed todo${n === 1 ? "" : "s"}`, "success");
            },
            (e) => {
              if (asked === a) closeDialog();
              notifier.notify(`Clearing failed: ${e instanceof Error ? e.message : e}`, "error");
            },
          );
          return;
        }
      }
    };
  };
  return { id: todosClearCompleted, behavior };
}
