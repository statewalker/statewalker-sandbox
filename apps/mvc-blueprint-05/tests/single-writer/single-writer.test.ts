/**
 * Acceptance criterion 3: a bundle's slice is written only by that bundle's update function.
 * Enforced three ways: the update's signature only receives (and returns) its own slice; committed
 * state is deep-frozen, so no one can write it in place; a second registration of a slice id throws.
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { shellPanels } from "../../src/bundles/shell/api/index.ts";
import { todosCollection } from "../../src/bundles/todos/api/index.ts";
import {
  contactsFeature,
  shellFeature,
  todosContactsFeature,
  todosFeature,
} from "../../src/features.ts";
import type { Msg, SliceDef, Store, UpdateEnv } from "../../src/kernel/index.ts";
import { type Harness, start, until } from "../support/harness.ts";

let h: Harness;
afterEach(async () => {
  await h.stop();
});
const all = [shellFeature, todosFeature, contactsFeature, todosContactsFeature];

describe("single writer", () => {
  it("every slice id is a bundle id, and each is registered by that bundle only", async () => {
    h = await start(all);
    expect(h.store.inspect().slices).toEqual([
      "shell.core",
      "todos.core",
      "todos.list",
      "todos.edit",
      "todos.clear-completed",
      "contacts.core",
      "contacts.list",
      "contacts.edit",
      "todos.contacts-link",
    ]);
    // todos.status has no slice: it only derives.
  });

  it("a second writer for an existing slice is refused", async () => {
    h = await start(all);
    expect(() =>
      h.store.addSlice({ id: "todos.core", init: () => ({ todos: [] }), update: (s) => s }),
    ).toThrow(/todos.core already has a writer/);
  });

  it("state and derived views are frozen: neither another update nor a view can write them", async () => {
    h = await start(all);
    await until(() => h.store.select(todosCollection).length === 1);
    const [todo] = h.store.select(todosCollection)[0]?.todos ?? [];
    expect(() => {
      (todo as { title: string }).title = "hacked";
    }).toThrow(TypeError);
    const panel = h.store.select(shellPanels)[0];
    expect(() => {
      (panel as { title: string }).title = "hacked";
    }).toThrow(TypeError);
    // an update that tries to write another slice through `select` fails the same way, and is contained
    h.store.addSlice({
      id: "intruder",
      init: () => 0,
      update: (s, msg, { select }) => {
        const [first] = select(todosCollection)[0]?.todos ?? [];
        if (msg.type === "attack") (first as { done: boolean }).done = true;
        return s;
      },
    });
    h.dispatch({ type: "attack" });
    expect(h.errors().map((e) => e.message)).toEqual(["update of intruder threw on attack"]);
    expect(h.store.select(todosCollection)[0]?.todos[0]?.done).toBe(false);
    h.logs.length = 0;
  });

  it("type level: an update receives only its own slice and the read-only env, and returns its slice", () => {
    type Update = SliceDef<{ n: number }>["update"];
    expectTypeOf<Parameters<Update>>().toEqualTypeOf<[{ n: number }, Msg, UpdateEnv]>();
    expectTypeOf<keyof UpdateEnv>().toEqualTypeOf<"select">();
    // there is no setter anywhere on the store surface a bundle sees, besides dispatch
    type HasSetter = "setState" extends keyof Store ? true : false;
    expectTypeOf<HasSetter>().toEqualTypeOf<false>();
  });
});
