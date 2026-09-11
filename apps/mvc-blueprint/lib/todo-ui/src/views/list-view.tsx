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
import type { TodoListModel } from "@todo/app/models";
import { type FormEvent, useState } from "react";
import { Checkbox } from "../components/checkbox.js";
import { shallowEqual, useModel } from "../use-model.js";

/**
 * The list panel — rendered for `ui:show-list`, and knowing only its model.
 *
 * Every gesture becomes a MUTATOR call on `model.input`, the sub-model the
 * view owns (spec §4.8): it never assigns a field, never notifies, and never
 * guesses an outcome — a toggled row stays unticked until the controller's
 * `replaceTodos` says otherwise. The one piece of local state is the add
 * form's draft, which is not model state: nothing but this form cares about a
 * half-typed title until it is submitted, and then it rides the event edge.
 */
export function ListView({ model }: { model: TodoListModel }) {
  // Every read is bound through the OUTER model: its `onUpdate` covers the
  // input's query fields (the model forwards them), so the rows depend on
  // `visible()` and nothing else — not on the controls happening to
  // subscribe to the same fields. A derived array, so it MUST be compared
  // shallowly (spec §4.3).
  const rows = useModel(model, (m) => m.visible(), shallowEqual);
  const filter = useModel(model, (m) => m.input.filterDraft);
  const showDone = useModel(model, (m) => m.input.showDone);
  const outcome = useModel(model, (m) => m.lastOutcome);
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (title === "") return; // `todos:add` would reject it; do not raise an edge for nothing
    model.input.queueSubmit(title);
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
            onChange={(e) => model.input.setFilter(e.target.value)}
          />
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Checkbox
              aria-label="Show completed"
              checked={showDone}
              onChange={(e) => model.input.setShowDone(e.target.checked)}
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
                <Checkbox checked={todo.done} onChange={() => model.input.requestToggle(todo.id)} />
                <span className={cn("text-sm", todo.done && "text-muted-foreground line-through")}>
                  {todo.title}
                </span>
              </label>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete "${todo.title}"`}
                onClick={() => model.input.requestRemove(todo.id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing to show.</p>}
      </CardContent>
      <CardFooter className="justify-end">
        <Button variant="outline" onClick={() => model.input.requestClearCompleted()}>
          Clear completed
        </Button>
      </CardFooter>
    </Card>
  );
}
