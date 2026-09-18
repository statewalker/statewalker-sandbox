/**
 * `todos.rename` — "Rename…" in the selection actions (exactly one todo selected) opens a dialog
 * with one title field; Rename updates the title at commit time; an empty title is a form error.
 */
import {
  type BundleManifest,
  type Contributed,
  contribute,
  defineStream,
} from "../../kernel/index.js";
import { type Dialog, dialogs } from "../shell/api/index.js";
import {
  collection,
  type RenameMsg,
  type RenameState,
  renameKind,
  selection,
  selectionActions,
  type Todo,
  todosCore,
  todosRename,
} from "../todos/api/index.js";

const view = defineStream<RenameState>("todos.rename:view");

export const todosRenameBundle: BundleManifest = {
  id: todosRename,
  behavior: (ctx) => {
    let todos: readonly Todo[] = [];
    let selected: readonly string[] = [];
    let session:
      | { id: string; title: string; error?: string; running: boolean; dialog: Contributed<Dialog> }
      | undefined;
    const item = () => ({
      order: 20,
      action: {
        id: "rename",
        label: "Rename…",
        enabled: selected.length === 1,
        to: todosRename,
        msg: { type: "open" },
      },
    });
    const action = contribute(ctx, selectionActions, "todos.rename", item());
    ctx.subscribe(collection, (c) => {
      todos = c?.todos ?? [];
    });
    ctx.subscribe(selection, (s) => {
      selected = s ?? [];
      action.update(item());
    });
    const render = () => {
      if (!session) return;
      ctx.publish(view, {
        title: session.title,
        error: session.error,
        rename: {
          id: "rename",
          label: "Rename",
          enabled: !session.running,
          running: session.running,
          to: todosRename,
          msg: { type: "rename" },
        },
        cancel: {
          id: "cancel",
          label: "Cancel",
          enabled: true,
          to: todosRename,
          msg: { type: "cancel" },
        },
      });
    };
    const close = () => {
      session?.dialog.withdraw();
      session = undefined;
    };
    return (msg: RenameMsg) => {
      switch (msg.type) {
        case "open": {
          const todo = selected.length === 1 ? todos.find((t) => t.id === selected[0]) : undefined;
          if (!todo || session) return;
          const dialog = contribute(ctx, dialogs, "todos:rename", {
            kind: renameKind.id,
            stream: view,
            inbox: todosRename,
            title: "Rename todo",
          });
          session = { id: todo.id, title: todo.title, running: false, dialog };
          return render();
        }
        case "edit":
          if (session) session.title = msg.title;
          return render();
        case "cancel":
          return close();
        case "rename": {
          const s = session;
          if (!s || s.running) return;
          const title = s.title.trim(); // the commit, captured now
          if (!title) {
            s.error = "Title is required";
            return render();
          }
          s.running = true;
          render();
          ctx.pipe(
            ctx.ask(todosCore, { type: "todos:update", id: s.id, patch: { title } }),
            () => session === s && close(),
            (e) => {
              if (session !== s) return;
              s.running = false;
              s.error = e instanceof Error ? e.message : String(e);
              render();
            },
          );
        }
      }
    };
  },
};
