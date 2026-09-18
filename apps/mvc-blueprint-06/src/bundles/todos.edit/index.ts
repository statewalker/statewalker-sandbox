/**
 * `todos.edit` — the editor. Answers `todos:edit:open` and `todos:compose`; contributes the Edit
 * selection action and the "New todo…" menu item. The draft lives here: every keystroke is a
 * message, so a Save acts on exactly the keystrokes that were sent before it (mailbox order).
 */
import {
  type ActionDesc,
  type Behavior,
  type BundleManifest,
  type Contributed,
  contribute,
  defineStream,
} from "../../kernel/index.js";
import { newNotifier } from "../../kit/notify.js";
import { menu, type Panel, panels } from "../shell/api/index.js";
import {
  collection,
  type EditorState,
  editorKind,
  selection,
  selectionActions,
  type Todo,
  type TodosEditMsg,
  todosCore,
  todosEdit,
} from "../todos/api/index.js";

const view = defineStream<EditorState>("todos.edit:view");

interface Session {
  readonly mode: "edit" | "create";
  readonly id?: string;
  title: string;
  error?: string;
  saving: boolean;
}

export function todosEditBundle(options: { notifyTimeoutMs?: number } = {}): BundleManifest {
  const behavior: Behavior<TodosEditMsg> = (ctx) => {
    const notifier = newNotifier(ctx, options.notifyTimeoutMs);
    let todos: readonly Todo[] = [];
    let selected: readonly string[] = [];
    let session: Session | undefined;
    let panel: Contributed<Panel> | undefined;

    const editItem = () => ({
      order: 10,
      action: {
        id: "edit",
        label: "Edit",
        enabled: selected.length === 1,
        to: todosEdit,
        msg: { type: "todos:edit:open", id: selected[0] ?? "" },
      } satisfies ActionDesc,
    });
    const editAction = contribute(ctx, selectionActions, "todos.edit:edit", editItem());
    contribute(ctx, menu, "todos.edit:new", {
      group: "todos",
      groupLabel: "Todos",
      order: 0,
      action: {
        id: "new",
        label: "New todo…",
        enabled: true,
        to: todosEdit,
        msg: { type: "todos:compose", title: "" },
      },
    });
    ctx.subscribe(collection, (c) => {
      todos = c?.todos ?? [];
    });
    ctx.subscribe(selection, (s) => {
      selected = s ?? [];
      editAction.update(editItem());
    });

    const render = () => {
      if (!session) return;
      ctx.publish(view, {
        mode: session.mode,
        title: session.title,
        error: session.error,
        save: {
          id: "save",
          label: session.saving ? "Saving…" : "Save",
          enabled: !session.saving,
          running: session.saving,
          to: todosEdit,
          msg: { type: "save" },
        },
        cancel: {
          id: "cancel",
          label: "Cancel",
          enabled: true,
          to: todosEdit,
          msg: { type: "cancel" },
        },
      });
    };
    const open = (next: Session) => {
      session = next;
      render();
      const title = next.mode === "create" ? "New todo" : `Edit "${next.title}"`;
      const value: Panel = {
        kind: editorKind.id,
        stream: view,
        inbox: todosEdit,
        title,
        placement: "side",
        order: 10,
      };
      if (panel) panel.update(value);
      else panel = contribute(ctx, panels, "todos:editor", value);
    };
    const close = () => {
      session = undefined;
      panel?.withdraw();
      panel = undefined;
    };

    return (msg, env) => {
      if (notifier.handle(msg)) return;
      switch (msg.type) {
        case "todos:edit:open": {
          const todo = todos.find((t) => t.id === msg.id);
          if (!todo) return env.fail(new Error(`no todo "${msg.id}"`));
          open({ mode: "edit", id: todo.id, title: todo.title, saving: false });
          return env.ok();
        }
        case "todos:compose":
          open({ mode: "create", title: msg.title, saving: false });
          return env.ok();
        case "edit":
          if (!session) return;
          session.title = msg.title;
          return render();
        case "cancel":
          return close();
        case "save": {
          const s = session;
          if (!s || s.saving) return; // refused visibly: Save shows disabled and "Saving…"
          const title = s.title.trim(); // the commit, captured now
          if (!title) {
            s.error = "Title is required";
            return render();
          }
          s.saving = true;
          render();
          const request =
            s.mode === "create"
              ? ctx.ask(todosCore, { type: "todos:add", title })
              : ctx.ask(todosCore, { type: "todos:update", id: s.id ?? "", patch: { title } });
          ctx.pipe(
            request,
            (todo) => {
              notifier.notify("Saved", "success");
              if (session !== s) return;
              // Typed while saving? That belongs to the next commit: stay open on the saved todo.
              if (s.title.trim() !== title) {
                session = { mode: "edit", id: todo.id, title: s.title, saving: false };
                return render();
              }
              close();
            },
            (e) => {
              if (session !== s) return;
              s.saving = false;
              s.error = e instanceof Error ? e.message : String(e);
              render();
            },
          );
          return;
        }
      }
    };
  };
  return { id: todosEdit, behavior };
}
