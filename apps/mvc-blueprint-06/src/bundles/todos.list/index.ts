/**
 * `todos.list` — the list panel. Owns the selection (published as `todos:selection`), the new-title
 * input, and the two action points it renders (`todos:toolbar-actions`, `todos:selection-actions`).
 */
import {
  type ActionItem,
  type Behavior,
  type BundleManifest,
  contribute,
  defineStream,
  ownPoints,
} from "../../kernel/index.js";
import { panels } from "../shell/api/index.js";
import {
  collection,
  type ListMsg,
  type ListState,
  listKind,
  selection,
  selectionActions,
  type Todo,
  todosCore,
  toolbarActions,
} from "../todos/api/index.js";

const ADDRESS = "todos.list";
const view = defineStream<ListState>("todos.list:view");

const behavior: Behavior<ListMsg> = (ctx) => {
  const points = ownPoints(ctx, [toolbarActions, selectionActions]);
  let todos: readonly Todo[] = [];
  let selected: readonly string[] = [];
  let newTitle = "";
  let toolbar: readonly ActionItem[] = [];
  let selActions: readonly ActionItem[] = [];
  let adding = false;
  let changing = false;

  const addAction = contribute(ctx, toolbarActions, "todos.list:add", addItem());
  const toggleAction = contribute(ctx, selectionActions, "todos.list:toggle", toggleItem());
  const deleteAction = contribute(ctx, selectionActions, "todos.list:delete", deleteItem());

  function addItem(): ActionItem {
    const enabled = newTitle.trim() !== "" && !adding;
    return {
      order: 0,
      action: {
        id: "add",
        label: "Add",
        enabled,
        running: adding,
        to: ADDRESS,
        msg: { type: "add" },
      },
    };
  }
  function toggleItem(): ActionItem {
    const enabled = selected.length > 0 && !changing;
    const msg = { type: "toggle-selected" };
    return { order: 0, action: { id: "toggle", label: "Toggle", enabled, to: ADDRESS, msg } };
  }
  function deleteItem(): ActionItem {
    const enabled = selected.length > 0 && !changing;
    const msg = { type: "delete-selected" };
    return { order: 30, action: { id: "delete", label: "Delete", enabled, to: ADDRESS, msg } };
  }

  const render = () => {
    ctx.publish(selection, selected);
    ctx.publish(view, { todos, selected, newTitle, toolbar, selectionActions: selActions });
    addAction.update(addItem());
    toggleAction.update(toggleItem());
    deleteAction.update(deleteItem());
  };

  ctx.subscribe(collection, (c) => {
    todos = c?.todos ?? [];
    const ids = new Set(todos.map((t) => t.id));
    selected = selected.filter((id) => ids.has(id));
    render();
  });
  ctx.subscribe(toolbarActions.key, (items) => {
    toolbar = (items ?? []).map((c) => c.value);
    render();
  });
  ctx.subscribe(selectionActions.key, (items) => {
    selActions = (items ?? []).map((c) => c.value);
    render();
  });
  render();
  contribute(ctx, panels, "todos:list", {
    kind: listKind.id,
    stream: view,
    inbox: ADDRESS,
    title: "Todos",
    placement: "main",
    order: 0,
  });

  const settle = (op: Promise<unknown>) => {
    changing = true;
    render();
    const done = () => {
      changing = false;
      render();
    };
    ctx.pipe(op, done, (e) => {
      ctx.log.warn("a todo change failed", e);
      done();
    });
  };

  return (msg, env) => {
    if (points.handle(msg, env)) return;
    switch (msg.type) {
      case "select":
        selected = msg.additive
          ? selected.includes(msg.id)
            ? selected.filter((id) => id !== msg.id)
            : [...selected, msg.id]
          : [msg.id];
        break;
      case "toggle-one": {
        const todo = todos.find((t) => t.id === msg.id);
        if (todo)
          settle(
            ctx.ask(todosCore, { type: "todos:update", id: todo.id, patch: { done: !todo.done } }),
          );
        return;
      }
      case "new-title":
        newTitle = msg.value;
        break;
      case "add": {
        const title = newTitle.trim();
        if (!title || adding) return; // refused visibly: the action shows disabled/running
        adding = true;
        ctx.pipe(
          ctx.ask(todosCore, { type: "todos:add", title }),
          () => {
            adding = false;
            // What was typed after the commit belongs to the next one: clear only what was committed.
            if (newTitle.trim() === title) newTitle = "";
            render();
          },
          (e) => {
            adding = false;
            ctx.log.warn("adding a todo failed", e);
            render();
          },
        );
        break;
      }
      case "toggle-selected": {
        if (changing) return;
        const picked = todos.filter((t) => selected.includes(t.id));
        settle(
          Promise.all(
            picked.map((t) =>
              ctx.ask(todosCore, { type: "todos:update", id: t.id, patch: { done: !t.done } }),
            ),
          ),
        );
        return;
      }
      case "delete-selected":
        if (changing || selected.length === 0) return;
        settle(ctx.ask(todosCore, { type: "todos:remove", ids: selected }));
        return;
    }
    render();
  };
};

export const todosListBundle: BundleManifest = { id: ADDRESS, behavior };
