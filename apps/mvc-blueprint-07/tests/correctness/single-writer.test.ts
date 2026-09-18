import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ContactDetailsView,
  ContactEditorView,
  ContactSelectionView,
  ContactsDirectoryView,
  ContactsListView,
} from "../../src/bundles/contacts/api/index.js";
import type { HeaderItemView, NotificationView } from "../../src/bundles/shell/api/index.js";
import * as shell from "../../src/bundles/shell/api/index.js";
import type {
  ClearCompletedView,
  TodoEditorView,
  TodosCollectionView,
  TodosListView,
  TodosSelectionView,
} from "../../src/bundles/todos/api/index.js";
import type { ActionView } from "../../src/kernel/models.js";
import { start } from "../support/headless.js";
import { ALL_SLOTS } from "../support/slots.js";
import { contactAction, contactList, openTodoEditor } from "../support/todos.js";

/** Members a view facet may never have: presentation or action-description writers. */
type Writers<T> = {
  [K in keyof T]: K extends
    | `set${string}`
    | `publish${string}`
    | `report${string}`
    | "update"
    | "reset"
    ? K
    : never;
}[keyof T];
const WRITER = /^(set[A-Z]|publish|report|update$|reset$)/;
/** What a view may call: field-level form writes and intents. */
const VIEW_CALLS = new Set([
  "editTitle",
  "editField",
  "editNewTitle",
  "select",
  "toggle",
  "submit",
  "dismiss",
]);

describe("single writer", () => {
  it("type level: no view facet exposes a presentation or action-description writer", () => {
    expectTypeOf<Writers<ActionView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<TodosListView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<TodoEditorView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<ClearCompletedView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<TodosCollectionView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<TodosSelectionView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<ContactsListView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<ContactDetailsView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<ContactEditorView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<ContactSelectionView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<ContactsDirectoryView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<HeaderItemView>>().toEqualTypeOf<never>();
    expectTypeOf<Writers<NotificationView>>().toEqualTypeOf<never>();
  });

  it("runtime: every published model is frozen, and its callables are getters, subscriptions or view intents", async () => {
    const app = await start();
    openTodoEditor(app, "t1");
    app.menu("Clear completed")?.submit();
    contactList(app).select("c1");
    contactAction(app, "Edit").submit();
    app.log.open("probe").append(shell.notify, { message: "hi", tone: "info" });
    const models: Array<[string, object]> = [];
    const visit = (where: string, value: unknown) => {
      if (!value || typeof value !== "object") return;
      const v = value as Record<string, unknown>;
      if ("model" in v) visit(`${where}.model`, v.model);
      if ("action" in v) visit(`${where}.action`, v.action);
      if (typeof v.getState === "function" || Object.keys(v).some((k) => k.startsWith("get"))) {
        models.push([where, v]);
        for (const [k, inner] of Object.entries(v))
          if (inner && typeof inner === "object") visit(`${where}.${k}`, inner);
      }
    };
    for (const slot of ALL_SLOTS) {
      const snapshot = app.slots.getSnapshot(slot as never) as unknown;
      const entries =
        snapshot instanceof Map
          ? [...snapshot.entries()]
          : (snapshot as unknown[]).map((v, i) => [i, v]);
      for (const [id, value] of entries)
        if (slot.key !== "ui.react:renderers") visit(`${slot.key}[${id}]`, value);
    }
    expect(models.length).toBeGreaterThan(20);
    const problems = models.flatMap(([where, m]) => [
      ...(Object.isFrozen(m) ? [] : [`${where} is not frozen`]),
      ...Object.entries(m)
        .filter(([, v]) => typeof v === "function")
        .map(([k]) => k)
        .filter(
          (k) =>
            WRITER.test(k) || !(k.startsWith("get") || k.startsWith("on") || VIEW_CALLS.has(k)),
        )
        .map((k) => `${where}.${k}`),
    ]);
    expect(problems).toEqual([]);
    await app.stop();
  });
});
