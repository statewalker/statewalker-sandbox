import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { type Todo, TodoListModel } from "@todo/app/models";
import { ListView } from "@todo/ui";
import { all, button, flush, render, waitFor } from "../../test-support/react.js";

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
  const model = new TodoListModel();
  model.replaceTodos([todo("1", "buy milk"), todo("2", "walk dog"), todo("3", "file taxes", true)]);
  return model;
};

const mountList = async (model: TodoListModel) => {
  const view = render(<ListView model={model} />);
  unmount = view.unmount;
  await waitFor(() => view.host.querySelector("ul") !== null);
  return view.host;
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
      const host = await mountList(seeded());
      expect(titles(host)).toEqual(["buy milk", "walk dog", "file taxes"]);
      const checked = all<HTMLInputElement>(host, 'li input[type="checkbox"]').map((c) => c.checked);
      expect(checked).toEqual([false, false, true]);
    });

    it("shows lastOutcome as an error line while it is set, and not otherwise", async () => {
      const model = seeded();
      const host = await mountList(model);
      expect(host.querySelector('[role="alert"]')).toBeNull();

      // The controller's mutator — the only way `lastOutcome` changes.
      model.reportOutcome('add "x" failed: the store is down');
      await waitFor(() => host.querySelector('[role="alert"]') !== null);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("the store is down");

      model.reportOutcome(undefined);
      await waitFor(() => host.querySelector('[role="alert"]') === null);
    });
  });

  describe("re-renders when visible() changes", () => {
    it("when the controller replaces the list", async () => {
      const model = seeded();
      const host = await mountList(model);
      model.replaceTodos([todo("1", "buy milk"), todo("4", "call mum")]);
      await waitFor(() => titles(host).length === 2);
      expect(titles(host)).toEqual(["buy milk", "call mum"]);
    });

    it("when the QUERY changes — visible() reads the input sub-model, whose updates the outer model never sees", async () => {
      // `visible()` lives on the outer model but reads `input.filterDraft` and
      // `input.showDone`, and `input.notify()` does not fire the outer
      // model's `onUpdate`. A list bound only to `useModel(model, m =>
      // m.visible())` would therefore ignore every filter keystroke. Driven
      // through the mutators, not the DOM, so this isolates the binding.
      const model = seeded();
      const host = await mountList(model);

      model.input.setFilter("MILK");
      await waitFor(() => titles(host).length === 1);
      expect(titles(host)).toEqual(["buy milk"]);

      model.input.setFilter("");
      model.input.setShowDone(false);
      await waitFor(() => titles(host).length === 2);
      expect(titles(host)).toEqual(["buy milk", "walk dog"]);
    });
  });

  describe("user input reaches the model only through a mutator", () => {
    it("typing in the filter calls setFilter with what was typed", async () => {
      const model = seeded();
      const host = await mountList(model);
      const setFilter = vi.spyOn(model.input, "setFilter");

      await userEvent.fill(input(host, "Filter"), "dog");

      expect(setFilter).toHaveBeenLastCalledWith("dog");
      // The field is the model's echo, not the view's own state: the rows follow.
      await waitFor(() => titles(host).length === 1);
      expect(titles(host)).toEqual(["walk dog"]);
      expect(input(host, "Filter").value).toBe("dog");
    });

    it("the show-completed checkbox calls setShowDone", async () => {
      const model = seeded();
      const host = await mountList(model);
      const setShowDone = vi.spyOn(model.input, "setShowDone");

      await userEvent.click(input(host, "Show completed"));

      expect(setShowDone).toHaveBeenCalledExactlyOnceWith(false);
    });

    it("submitting the add form calls queueSubmit(title) and clears the draft", async () => {
      const model = seeded();
      const host = await mountList(model);
      const queueSubmit = vi.spyOn(model.input, "queueSubmit");

      await userEvent.fill(input(host, "New todo"), "  buy bread ");
      await userEvent.click(button(host, "Add")!);

      expect(queueSubmit).toHaveBeenCalledExactlyOnceWith("buy bread");
      await waitFor(() => input(host, "New todo").value === "");

      // Enter submits too — it is a form.
      await userEvent.type(input(host, "New todo"), "walk cat{Enter}");
      expect(queueSubmit).toHaveBeenLastCalledWith("walk cat");
    });

    it("a blank draft submits nothing", async () => {
      const model = seeded();
      const host = await mountList(model);
      const queueSubmit = vi.spyOn(model.input, "queueSubmit");

      await userEvent.fill(input(host, "New todo"), "   ");
      await userEvent.click(button(host, "Add")!);

      expect(queueSubmit).not.toHaveBeenCalled();
    });

    it("a row's checkbox calls requestToggle(id) — and the row keeps showing the MODEL until it changes", async () => {
      const model = seeded();
      const host = await mountList(model);
      const requestToggle = vi.spyOn(model.input, "requestToggle");
      const box = row(host, "walk dog").querySelector<HTMLInputElement>('input[type="checkbox"]')!;

      await userEvent.click(box);

      expect(requestToggle).toHaveBeenCalledExactlyOnceWith("2");
      // The view does not guess the outcome: `todos` has not changed, so the
      // row still reads not-done. Only the controller's `replaceTodos` moves it.
      await flush();
      expect(box.checked).toBe(false);
      model.replaceTodos([todo("1", "buy milk"), todo("2", "walk dog", true), todo("3", "file taxes", true)]);
      await waitFor(() => box.checked);
    });

    it("a row's delete button calls requestRemove(id)", async () => {
      const model = seeded();
      const host = await mountList(model);
      const requestRemove = vi.spyOn(model.input, "requestRemove");

      await userEvent.click(button(row(host, "file taxes"), 'Delete "file taxes"')!);

      expect(requestRemove).toHaveBeenCalledExactlyOnceWith("3");
    });

    it("Clear completed calls requestClearCompleted()", async () => {
      const model = seeded();
      const host = await mountList(model);
      const requestClearCompleted = vi.spyOn(model.input, "requestClearCompleted");

      await userEvent.click(button(host, "Clear completed")!);

      expect(requestClearCompleted).toHaveBeenCalledExactlyOnceWith();
    });
  });
});
