import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  cn,
} from "@statewalker/ui.view.shadcn";
import type { TodoListView } from "@todo/app/models";
import { type FormEvent, useState } from "react";
import { Checkbox } from "../components/checkbox.js";
import { shallowEqual, useValue } from "../use-value.js";

/**
 * The list panel — rendered for `ui:show-list`, and knowing only its facet.
 *
 * It is handed `TodoListView` and nothing else: reads to render, and the
 * view-side mutators to raise intents. It cannot reach a result writer — it was
 * never given one. It never guesses an outcome: a toggled row stays unticked
 * until the controller's `replaceTodos` says otherwise. Its one piece of local
 * state is the add form's draft, which is not model state until it is
 * submitted, and then it rides the event edge.
 */
export function ListView({ model }: { model: TodoListView }) {
  // `visible` is a computed: the same reference until an input changes. A new
  // `todos` array with equal rows recomputes it, so `shallowEqual` spares that
  // re-render.
  const rows = useValue(model.visible, shallowEqual);
  const filter = useValue(model.filterDraft);
  const showDone = useValue(model.showDone);
  const outcome = useValue(model.lastOutcome);
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (title === "") return; // `todos:add` would reject it; do not raise an edge for nothing
    model.queueSubmit(title);
    setDraft("");
  };

  return (
    <Card className="w-full max-w-xl">
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
            value={filter}
            onChange={(e) => model.setFilter(e.target.value)}
          />
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Checkbox
              aria-label="Show completed"
              checked={showDone}
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
      <CardFooter className="justify-end">
        <Button variant="outline" onClick={() => model.requestClearCompleted()}>
          Clear completed
        </Button>
      </CardFooter>
    </Card>
  );
}
