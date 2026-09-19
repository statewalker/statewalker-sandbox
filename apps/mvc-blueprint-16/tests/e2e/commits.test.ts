import { MemContactsApi } from "@b/contacts.core";
import { MemTodoApi } from "@b/todos.core";
import { afterEach, describe, expect, it } from "vitest";
import { workbench } from "../../src/apps/workbenches.js";
import { button, click, open, type Page, typeInto, waitFor } from "./dom.js";
import { q } from "./scenarios.js";

/**
 * Commit time THROUGH THE INTERPRETERS: real gestures on spec-rendered views, a slow api, and the
 * gestures that race it packed into one tick. The spec can only call `submit()`; what a commit
 * means is captured by P0's controllers, unchanged — these tests show the interpreters add no
 * second capture, no retry and no queue of their own.
 */
const DELAY = 40;

describe.each(["dom", "solid"] as const)("commit time through the %s interpreter", (tech) => {
  let page: Page | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  async function openEditor(p: Page, name: string): Promise<HTMLElement> {
    const $ = q(p);
    await waitFor(() => $.tab("Contacts") !== undefined);
    click($.tab("Contacts"));
    await waitFor(() => $.contactRow(name) !== undefined);
    click($.contactRow(name));
    const list = () => $.panel("contacts:list") as HTMLElement;
    await waitFor(() => button(list(), "Edit")?.disabled === false);
    click(button(list(), "Edit"));
    await waitFor(() => $.panel("contacts:editor") !== null);
    return $.panel("contacts:editor") as HTMLElement;
  }

  it("Save acts on the form at the press; a second press and Enter in the same tick are refused", async () => {
    const api = new MemContactsApi(undefined, DELAY);
    page = await open(workbench(tech), { "contacts:api": api });
    const editor = await openEditor(page, "Ada Lovelace");
    const email = () => editor.querySelector('input[aria-label="Email"]');
    typeInto(email(), "ada@new.org");
    // One tick: press, type, press again, submit the form with Enter.
    click(button(editor, "Save"));
    typeInto(email(), "ada@typed-after.org");
    click(button(editor, "Save"));
    editor
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    // Refused visibly while it runs.
    await waitFor(() => button(editor, "Save")?.getAttribute("aria-busy") === "true");
    expect(button(editor, "Save")?.disabled).toBe(true);
    const $ = q(page);
    await waitFor(() => $.panel("contacts:editor") === null);
    const updates = api.calls.filter((c) => c.method === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args[1]).toMatchObject({ email: "ada@new.org" });
    expect(page.errors()).toEqual([]);
  });

  it("the row checkbox pressed twice in one tick toggles once, and stays controlled", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    page = await open(workbench(tech), { "todos:api": api });
    const $ = q(page);
    await waitFor(() => $.todoTitles().length === 3);
    const box = () =>
      $.panel("todos:list")?.querySelector(
        'input[aria-label="Done: Buy milk"]',
      ) as HTMLInputElement;
    click(box());
    // Controlled: the model has not changed yet, so the box shows the model's value, not the DOM's.
    expect(box().checked).toBe(false);
    click(box());
    await waitFor(
      () =>
        $.todoRow("Buy milk")?.querySelector("span")?.className.includes("line-through") === true,
    );
    await new Promise((r) => setTimeout(r, DELAY * 2));
    expect(api.calls.filter((c) => c.method === "update")).toHaveLength(1);
    expect(box().checked).toBe(true);
    expect(page.errors()).toEqual([]);
  });

  it("Add is queued: three presses while it runs make three todos, each with its own title", async () => {
    const api = new MemTodoApi(undefined, DELAY);
    page = await open(workbench(tech), { "todos:api": api });
    const $ = q(page);
    await waitFor(() => $.todoTitles().length === 3);
    const list = $.panel("todos:list") as HTMLElement;
    const input = () => list.querySelector('input[aria-label="New todo"]');
    for (const title of ["One", "Two", "Three"]) {
      typeInto(input(), title);
      click(button(list, "Add"));
    }
    await waitFor(() => $.todoTitles().length === 6, 3000);
    expect($.todoTitles().slice(3)).toEqual(["One", "Two", "Three"]);
    expect(page.errors()).toEqual([]);
  });
});
