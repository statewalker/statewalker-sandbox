/**
 * §13.3 Removal: the workbench without `todos-contacts`, `todos.status`, Contacts, or Todos.
 * The remaining behaviour works, nothing is logged at error level, and the only trace is the
 * coverage report (printed).
 */
import { describe, expect, it } from "vitest";
import {
  contactsListIntents,
  type ContactsListProps,
} from "../../src/bundles/contacts/api/index.ts";
import { type TodosListProps, todosListIntents } from "../../src/bundles/todos/api/index.ts";
import {
  contactsFeature,
  shellFeature,
  todosContactsFeature,
  todosFeature,
} from "../../src/features.ts";
import type { FeatureManifest } from "../../src/kernel/index.ts";
import { start, until } from "../support/harness.ts";
import { user } from "../support/user.ts";

const withoutBundle = (f: FeatureManifest, id: string): FeatureManifest => ({
  ...f,
  bundles: f.bundles.filter((b) => b.id !== id),
});

const cases: Record<string, FeatureManifest[]> = {
  "todos-contacts": [shellFeature, todosFeature, contactsFeature],
  "todos.status": [
    shellFeature,
    withoutBundle(todosFeature, "todos.status"),
    contactsFeature,
    todosContactsFeature,
  ],
  contacts: [shellFeature, todosFeature],
  todos: [shellFeature, contactsFeature],
};

describe("removal", () => {
  for (const [removed, features] of Object.entries(cases)) {
    it(`without ${removed}: the rest works, no error, coverage only`, async () => {
      const h = await start(features);
      const u = user(h.store);
      const has = (id: string) => features.some((f) => f.id === id);
      if (has("todos")) {
        await until(() => !!u.panel("todos.list"));
        h.dispatch(todosListIntents.toggle({ id: "t1" }));
        await until(() => u.panel<TodosListProps>("todos.list")?.props.rows[0]?.done === true);
        expect(u.header()).toEqual(removed === "todos.status" ? [] : ["1 open todos"]);
      }
      if (has("contacts")) {
        await until(() => !!u.panel("contacts.list"));
        h.dispatch(contactsListIntents.select({ id: "c1" }));
        const labels = u
          .panel<ContactsListProps>("contacts.list")
          ?.props.selectionActions.map((a) => a.label);
        expect(labels).toEqual(
          has("todos-contacts") ? ["Edit", "New todo for this contact"] : ["Edit"],
        );
      }
      const groups = [...new Set(u.menu().map((m) => m.groupLabel))].sort();
      expect(groups).toEqual(
        [has("contacts") && "Contacts", has("todos") && "Todos"].filter(Boolean),
      );
      expect(h.errors()).toEqual([]);
      const coverage = h.store.coverage();
      console.log(`coverage without ${removed}:`, JSON.stringify(coverage));
      await h.stop();
      expect(h.errors()).toEqual([]);
    });
  }
});
