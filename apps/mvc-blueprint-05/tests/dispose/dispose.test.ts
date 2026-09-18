/** §13.5 Dispose: after the application's cleanup nothing is left and nothing writes late. */
import { describe, expect, it } from "vitest";
import { contactEditorIntents, contactsListIntents } from "../../src/bundles/contacts/api/index.ts";
import { createMemContactApi } from "../../src/bundles/contacts.core/mem-api.ts";
import { shellNotify } from "../../src/bundles/shell/api/index.ts";
import {
  contactsFeature,
  helloFeature,
  shellFeature,
  todosContactsFeature,
  todosFeature,
} from "../../src/features.ts";
import { gate, start, until } from "../support/harness.ts";
import { user } from "../support/user.ts";

describe("dispose", () => {
  it("empties the store: no slice, no contribution, no handler, no effect, no timer", async () => {
    const h = await start(
      [shellFeature, todosFeature, contactsFeature, todosContactsFeature, helloFeature],
      {
        "shell:notification-timeout-ms": 50,
      },
    );
    h.dispatch(shellNotify({ message: "hi", tone: "info" }));
    expect(h.store.inspect().subscriptions).toBe(1); // the toast's timer
    await h.stop();
    expect(h.store.inspect()).toEqual({
      slices: [],
      contributions: 0,
      effectHandlers: 0,
      effectsInFlight: 0,
      subscriptions: 0,
      listeners: 0,
    });
    expect(h.store.getState()).toEqual({});
    await new Promise((r) => setTimeout(r, 80)); // the timer would have fired by now
    expect(h.errors()).toEqual([]);
  });

  it("a save in flight at cleanup writes nothing when it resolves late", async () => {
    const g = gate();
    const h = await start([shellFeature, contactsFeature], {
      "contacts:api": createMemContactApi({ delay: () => g.wait() }),
    });
    const u = user(h.store);
    await until(() => g.pending > 0);
    g.release();
    await until(() => !!u.panel("contacts.list"));
    h.dispatch(contactsListIntents.select({ id: "c1" }));
    h.dispatch({ type: "contacts.edit/edit-selected" });
    h.dispatch(contactEditorIntents.field({ field: "name", value: "Ada" }));
    u.press(u.panel<{ save: never }>("contacts.edit")?.props.save);
    await until(() => g.pending > 0);
    await h.stop();
    let notified = 0;
    h.store.subscribe(() => notified++);
    g.openAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(notified).toBe(0);
    expect(h.store.getState()).toEqual({});
    expect(h.logs.some((l) => l.level === "debug" && /dropped/.test(l.message))).toBe(true);
    expect(h.errors()).toEqual([]);
  });

  it("toasts are withdrawn by their timeout (the subscription), and on dismiss", async () => {
    const h = await start([shellFeature], { "shell:notification-timeout-ms": 20 });
    const u = user(h.store);
    h.dispatch(shellNotify({ message: "one", tone: "info" }));
    h.dispatch(shellNotify({ message: "two", tone: "info" }));
    expect(u.toasts()).toEqual(["info:one", "info:two"]);
    const [first] = h.store.select(
      (await import("../../src/bundles/shell/api/index.ts")).shellNotifications,
    );
    h.dispatch(first?.dismiss as never);
    expect(u.toasts()).toEqual(["info:two"]);
    await until(() => u.toasts().length === 0);
    await h.stop();
  });
});
