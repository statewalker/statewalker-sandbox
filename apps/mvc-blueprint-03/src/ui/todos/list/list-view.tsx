import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Input,
} from "@statewalker/ui.view.shadcn";
import type { ActionView } from "@sys/action/model";
import { todosSelectionActionsSlot, todosToolbarActionsSlot } from "@sys/extension-points";
import type { TodoListView } from "@todos/list/model";
import { useModel } from "@ui/host";
import { ActionBar, ActionMenu } from "@ui/sys/action";
import { type FormEvent, type MouseEvent, useState } from "react";
import { Checkbox } from "../../sys/checkbox.js";

/**
 * The todo list panel. Data goes into the model (new title, filter, selection);
 * intents are the model's actions. A row gesture is a composition of both:
 * select the row, then submit the action.
 */
export function TodoListPanel({ model }: { model: TodoListView }) {
  const rows = useModel(model.getVisible, model.onVisibleUpdate);
  const query = useModel(model.getQuery, model.onQueryUpdate);
  const selection = useModel(model.getSelection, model.onSelectionUpdate);
  const newTitle = useModel(model.getNewTitle, model.onNewTitleUpdate);
  const outcome = useModel(model.getOutcome, model.onOutcomeUpdate);
  // A row control is disabled while its own action runs: a second gesture would move the selection
  // while its submit is ignored. Enablement is not read here — the gesture selects the row first.
  const { toggle, edit, remove } = model.actions;
  const toggling = useModel(toggle.getState, toggle.onStateUpdate).running;
  const editing = useModel(edit.getState, edit.onStateUpdate).running;
  const removing = useModel(remove.getState, remove.onStateUpdate).running;
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined);
  const selected = new Set(selection);

  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    model.actions.add.submit();
  };
  // Handlers read the selection from the model, not from this render: two gestures can land before React re-renders.
  const onRowClick = (event: MouseEvent, id: string) => {
    const current = model.getSelection();
    if (event.ctrlKey || event.metaKey) {
      model.select(current.includes(id) ? current.filter((s) => s !== id) : [...current, id]);
    } else {
      model.select([id]);
    }
  };
  const onRowMenu = (event: MouseEvent, id: string) => {
    event.preventDefault();
    if (!model.getSelection().includes(id)) model.select([id]);
    setMenu({ x: event.clientX, y: event.clientY });
  };
  const onRow = (id: string, action: ActionView) => (event: MouseEvent) => {
    event.stopPropagation();
    model.select([id]);
    action.submit();
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Todos</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex gap-2" onSubmit={submitNew}>
          <Input
            aria-label="New todo"
            placeholder="What needs doing?"
            value={newTitle}
            onChange={(event) => model.setNewTitle(event.target.value)}
          />
        </form>
        <ActionBar slot={todosToolbarActionsSlot} label="Todo actions" />
        <div className="flex items-center gap-3">
          <Input
            aria-label="Filter"
            type="search"
            placeholder="Filter"
            value={query.filterDraft}
            onChange={(event) => model.setFilter(event.target.value)}
          />
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox renders the <input> this label wraps */}
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Checkbox
              aria-label="Show completed"
              checked={query.showDone}
              onChange={(event) => model.setShowDone(event.target.checked)}
            />
            Show completed
          </label>
        </div>
        {outcome !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {outcome}
          </p>
        )}
        <ul aria-label="Todos" className="flex flex-col divide-y">
          {rows.map((todo) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: row selection by pointer; keyboard users act through the row's buttons
            <li
              key={todo.id}
              data-todo={todo.id}
              aria-selected={selected.has(todo.id)}
              className={cn(
                "flex items-center gap-3 rounded px-2 py-2",
                selected.has(todo.id) && "bg-accent",
              )}
              onClick={(event) => onRowClick(event, todo.id)}
              onContextMenu={(event) => onRowMenu(event, todo.id)}
            >
              <Checkbox
                aria-label={`Done: ${todo.title}`}
                checked={todo.done}
                disabled={toggling}
                aria-busy={toggling}
                onClick={(event) => event.stopPropagation()}
                onChange={() => {
                  model.select([todo.id]);
                  toggle.submit();
                }}
              />
              <span
                className={cn("flex-1 text-sm", todo.done && "text-muted-foreground line-through")}
              >
                {todo.title}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Edit "${todo.title}"`}
                disabled={editing}
                aria-busy={editing}
                onClick={onRow(todo.id, edit)}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Delete "${todo.title}"`}
                disabled={removing}
                aria-busy={removing}
                onClick={onRow(todo.id, remove)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing to show.</p>}
      </CardContent>
      {menu && (
        <ActionMenu
          slot={todosSelectionActionsSlot}
          label="Selection actions"
          position={menu}
          onClose={() => setMenu(undefined)}
        />
      )}
    </Card>
  );
}
