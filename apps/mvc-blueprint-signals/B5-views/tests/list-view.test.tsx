import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createTodoListModel, type Todo, type TodoListModel, type TodoListView } from "@todo/app/models";
import { ListView } from "@todo/ui";
import { all, button, flush, render, waitFor } from "../../test-support/react.js";
import { snapshotOf } from "../../test-support/signals.js";

/**
 * B5 · the list panel — spec §1.1: views know only models.
 *
 * Every assertion about user input is an assertion about a MUTATOR CALL, never
 * about a field having changed: the view's whole contract is "turn a gesture
 * into the model's named intention" (§4.8). What happens next — the controller
 * draining the queue, the api answering, `replaceTodos` — is B3's business, and
 * is simulated here by calling the controller-side mutators directly.
 */

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

const todo = (id: string, title: string, done = false): Todo => ({ id, title, done });

const seeded = () => {
  const model = createTodoListModel();
  model.control.replaceTodos([todo("1", "buy milk"), todo("2", "walk dog"), todo("3", "file taxes", true)]);
  return model;
};

/** Mounts the list over `view` — the real facet, or a copy with one mutator stubbed. */
const mountList = async (view: TodoListView) => {
  const rendered = render(<ListView model={view} />);
  unmount = rendered.unmount;
  await waitFor(() => rendered.host.querySelector("ul") !== null);
  await flush(); // let the passive effects subscribe before a test drives the model
  return rendered.host;
};

const titles = (host: HTMLElement) => all(host, "li").map((li) => li.querySelector("label")?.textContent?.trim());
const row = (host: HTMLElement, title: string) => {
  const li = all(host, "li").find((l) => l.textContent?.includes(title));
  if (!li) throw new Error(`no row "${title}"`);
  return li;
};
const input = (host: HTMLElement, label: string) => {
  const el = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!el) throw new Error(`no input "${label}"`);
  return el;
};

describe("ListView", () => {
  describe("renders from its model", () => {
    it("one row per visible todo, with its done state", async () => {
      const host = await mountList(seeded().view);
      expect(titles(host)).toEqual(["buy milk", "walk dog", "file taxes"]);
      const checked = all<HTMLInputElement>(host, 'li input[type="checkbox"]').map((c) => c.checked);
      expect(checked).toEqual([false, false, true]);
    });

    it("shows lastOutcome as an error line while it is set, and not otherwise", async () => {
      const model = seeded();
      const host = await mountList(model.view);
      expect(host.querySelector('[role="alert"]')).toBeNull();

      // The controller's mutator — the only way `lastOutcome` changes.
      model.control.reportOutcome('add "x" failed: the store is down');
      await waitFor(() => host.querySelector('[role="alert"]') !== null);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("the store is down");

      model.control.reportOutcome(undefined);
      await waitFor(() => host.querySelector('[role="alert"]') === null);
    });
  });

  describe("re-renders when visible() changes", () => {
    it("when the controller replaces the list", async () => {
      const model = seeded();
      const host = await mountList(model.view);
      model.control.replaceTodos([todo("1", "buy milk"), todo("4", "call mum")]);
      await waitFor(() => titles(host).length === 2);
      expect(titles(host)).toEqual(["buy milk", "call mum"]);
    });

    it("when the QUERY changes — visible is a computed over the filter, the flag and the list", async () => {
      // The list is bound only to `useValue(model.view.visible)`. That holds
      // because `visible` reads filterDraft and showDone unconditionally, so
      // both are dependencies even over an empty list (B1 pins that). Driven
      // through the mutators, not the DOM, so this isolates the binding.
      const model = seeded();
      const host = await mountList(model.view);

      model.view.setFilter("MILK");
      await waitFor(() => titles(host).length === 1);
      expect(titles(host)).toEqual(["buy milk"]);

      model.view.setFilter("");
      model.view.setShowDone(false);
      await waitFor(() => titles(host).length === 2);
      expect(titles(host)).toEqual(["buy milk", "walk dog"]);
    });
  });

  describe("each half of the query re-renders the rows ALONE, in its own tick", () => {
    // The test above moves filter and showDone together, so a binding that
    // covers only one half passes it. These do not: each changes one level
    // field and waits for the DOM before touching anything else. Each changes
    // it TWICE: a first change can land before React's passive effect
    // subscribes, and React's post-subscribe snapshot check then re-renders
    // for it — masking a missing subscription. The second change cannot.
    it("setShowDone alone hides and shows the completed row", async () => {
      const model = seeded();
      const host = await mountList(model.view);

      model.view.setShowDone(false);
      await waitFor(() => titles(host).length === 2);
      expect(titles(host)).toEqual(["buy milk", "walk dog"]);
      expect(input(host, "Show completed").checked, "the control echoes the model").toBe(false);

      model.view.setShowDone(true);
      await waitFor(() => titles(host).length === 3);
    });

    it("setFilter alone narrows the rows", async () => {
      const model = seeded();
      const host = await mountList(model.view);

      model.view.setFilter("taxes");
      await waitFor(() => titles(host).length === 1);
      expect(titles(host)).toEqual(["file taxes"]);

      model.view.setFilter("");
      await waitFor(() => titles(host).length === 3);
    });
  });

  describe("user input reaches the model only through a mutator", () => {
    // Each gesture's mutator is STUBBED — the view is handed a copy of its facet
    // with that one function replaced — and the whole model is snapshotted
    // around the gesture. With the mutator inert, ANY change to the model is
    // the view's own doing, through some other view-side mutator, and fails
    // here. (A frozen facet cannot be spied on in place; copying it is how a
    // test swaps one function.)
    const snapshot = snapshotOf;
    const withStub = <K extends keyof TodoListView>(model: TodoListModel, key: K, stub: TodoListView[K]) =>
      ({ ...model.view, [key]: stub }) as TodoListView;

    it("typing in the filter calls setFilter with what was typed — and writes nothing itself", async () => {
      const model = seeded();
      const setFilter = vi.fn();
      const host = await mountList(withStub(model, "setFilter", setFilter));
      const before = snapshot(model);

      await userEvent.fill(input(host, "Filter"), "dog");

      expect(setFilter).toHaveBeenLastCalledWith("dog");
      expect(snapshot(model)).toEqual(before);
      // The field is controlled BY THE MODEL: with the mutator inert, the
      // model still says "", so the field snaps back to it.
      await flush();
      expect(input(host, "Filter").value).toBe("");
    });

    it("the show-completed checkbox calls setShowDone — and writes nothing itself", async () => {
      const model = seeded();
      const setShowDone = vi.fn();
      const host = await mountList(withStub(model, "setShowDone", setShowDone));
      const before = snapshot(model);

      await userEvent.click(input(host, "Show completed"));

      expect(setShowDone).toHaveBeenCalledExactlyOnceWith(false);
      expect(snapshot(model)).toEqual(before);
      await flush();
      expect(input(host, "Show completed").checked, "still the model's value").toBe(true);
    });

    it("submitting the add form calls queueSubmit(title), clears the draft, and writes nothing itself", async () => {
      const model = seeded();
      const queueSubmit = vi.fn();
      const host = await mountList(withStub(model, "queueSubmit", queueSubmit));
      const before = snapshot(model);

      await userEvent.fill(input(host, "New todo"), "  buy bread ");
      await userEvent.click(button(host, "Add")!);

      expect(queueSubmit).toHaveBeenCalledExactlyOnceWith("buy bread");
      await waitFor(() => input(host, "New todo").value === "");

      // Enter submits too — it is a form.
      await userEvent.type(input(host, "New todo"), "walk cat{Enter}");
      expect(queueSubmit).toHaveBeenLastCalledWith("walk cat");
      expect(snapshot(model)).toEqual(before);
    });

    it("a blank draft submits nothing", async () => {
      const model = seeded();
      const queueSubmit = vi.fn();
      const host = await mountList(withStub(model, "queueSubmit", queueSubmit));
      const before = snapshot(model);

      await userEvent.fill(input(host, "New todo"), "   ");
      await userEvent.click(button(host, "Add")!);

      expect(queueSubmit).not.toHaveBeenCalled();
      expect(snapshot(model)).toEqual(before);
    });

    it("a row's checkbox calls requestToggle(id) — and the row keeps showing the MODEL until it changes", async () => {
      const model = seeded();
      const requestToggle = vi.fn();
      const host = await mountList(withStub(model, "requestToggle", requestToggle));
      const before = snapshot(model);
      const box = row(host, "walk dog").querySelector<HTMLInputElement>('input[type="checkbox"]')!;

      await userEvent.click(box);

      expect(requestToggle).toHaveBeenCalledExactlyOnceWith("2");
      expect(snapshot(model)).toEqual(before);
      // The view does not guess the outcome: `todos` has not changed, so the
      // row still reads not-done. Only the controller's `replaceTodos` moves it.
      await flush();
      expect(box.checked).toBe(false);
      model.control.replaceTodos([todo("1", "buy milk"), todo("2", "walk dog", true), todo("3", "file taxes", true)]);
      await waitFor(() => box.checked);
    });

    it("a row's delete button calls requestRemove(id) — and writes nothing itself", async () => {
      const model = seeded();
      const requestRemove = vi.fn();
      const host = await mountList(withStub(model, "requestRemove", requestRemove));
      const before = snapshot(model);

      await userEvent.click(button(row(host, "file taxes"), 'Delete "file taxes"')!);

      expect(requestRemove).toHaveBeenCalledExactlyOnceWith("3");
      expect(snapshot(model)).toEqual(before);
    });

    it("Clear completed calls requestClearCompleted() — and writes nothing itself", async () => {
      const model = seeded();
      const requestClearCompleted = vi.fn();
      const host = await mountList(withStub(model, "requestClearCompleted", requestClearCompleted));
      const before = snapshot(model);

      await userEvent.click(button(host, "Clear completed")!);

      expect(requestClearCompleted).toHaveBeenCalledExactlyOnceWith();
      expect(snapshot(model)).toEqual(before);
    });
  });

  it("the filter field echoes the model once the real mutator runs", async () => {
    const model = seeded();
    const host = await mountList(model.view);

    await userEvent.fill(input(host, "Filter"), "dog");

    await waitFor(() => titles(host).length === 1);
    expect(titles(host)).toEqual(["walk dog"]);
    expect(input(host, "Filter").value).toBe("dog");
  });
});
