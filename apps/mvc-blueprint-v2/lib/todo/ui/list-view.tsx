import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
  Input,
} from "@statewalker/ui.view.shadcn";
import type { TodoListView } from "@todo/models";
import { useModel } from "@ui/react";
import { type FormEvent, useState } from "react";
import { Checkbox } from "./checkbox.js";

export const SAMPLE_COUNT = 5;

/**
 * The todo list panel. It knows only its view facet: reads to render, intents
 * to raise. A ticked row stays unticked until the controller's reload says
 * otherwise — the view never guesses an outcome.
 */
export function ListView({ model }: { model: TodoListView }) {
  const rows = useModel(model.getVisible, model.onVisibleUpdate);
  const query = useModel(model.getQuery, model.onQueryUpdate);
  const outcome = useModel(model.getOutcome, model.onOutcomeUpdate);
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (title === "") return;
    model.queueSubmit(title);
    setDraft("");
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Todos</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex gap-2" onSubmit={submit}>
          <Input
            aria-label="New todo"
            placeholder="What needs doing?"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit">Add</Button>
        </form>
        <div className="flex items-center gap-3">
          <Input
            aria-label="Filter"
            type="search"
            placeholder="Filter"
            value={query.filterDraft}
            onChange={(e) => model.setFilter(e.target.value)}
          />
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the kit's Checkbox renders the <input> this label wraps */}
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Checkbox
              aria-label="Show completed"
              checked={query.showDone}
              onChange={(e) => model.setShowDone(e.target.checked)}
            />
            Show completed
          </label>
        </div>
        {outcome !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {outcome}
          </p>
        )}
        <ul className="flex flex-col divide-y">
          {rows.map((todo) => (
            <li key={todo.id} className="flex items-center gap-3 py-2">
              {/* biome-ignore lint/a11y/noLabelWithoutControl: the kit's Checkbox renders the <input> this label wraps */}
              <label className="flex flex-1 items-center gap-3">
                <Checkbox checked={todo.done} onChange={() => model.requestToggle(todo.id)} />
                <span className={cn("text-sm", todo.done && "text-muted-foreground line-through")}>
                  {todo.title}
                </span>
              </label>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete "${todo.title}"`}
                onClick={() => model.requestRemove(todo.id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing to show.</p>}
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <Button variant="secondary" onClick={() => model.requestSampleTodos(SAMPLE_COUNT)}>
          Add sample activity
        </Button>
        <Button variant="outline" onClick={() => model.requestClearCompleted()}>
          Clear completed
        </Button>
      </CardFooter>
    </Card>
  );
}
