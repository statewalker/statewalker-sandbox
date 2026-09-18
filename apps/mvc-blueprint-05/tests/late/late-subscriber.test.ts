/** §13.5 Late subscriber and read-then-set. */
import { describe, expect, it } from "vitest";
import { shellHeader } from "../../src/bundles/shell/api/index.ts";
import { activate as todosStatus } from "../../src/bundles/todos.status/index.ts";
import { contactsFeature, shellFeature, todosFeature } from "../../src/features.ts";
import {
  createLogger,
  getKey,
  getLogger,
  getStore,
  newAdapter,
  setKey,
  setLogger,
} from "../../src/kernel/index.ts";
import { start, until } from "../support/harness.ts";
import { user } from "../support/user.ts";

describe("late subscriber", () => {
  it("todos.status activated before todos.core still shows the count", async () => {
    const reordered = {
      ...todosFeature,
      bundles: [
        { id: "todos.status", activator: todosStatus },
        ...todosFeature.bundles.filter((b) => b.id !== "todos.status"),
      ],
    };
    const h = await start([shellFeature, reordered]);
    await until(() => h.store.select(shellHeader).length === 1);
    expect(user(h.store).header()).toEqual(["2 open todos"]);
    await h.stop();
  });

  it("a feature activated after the others appears without a reload", async () => {
    const h = await start([shellFeature, todosFeature]);
    const u = user(h.store);
    await until(() => !!u.panel("todos.list"));
    const seen: string[][] = [];
    h.store.subscribe(() => seen.push(u.panelIds()));
    const { application } = await import("../../src/kernel/index.ts");
    const stopContacts = await application({
      id: "late",
      features: [shellFeatureStub(), contactsFeature],
    })(h.context);
    await until(() => !!u.panel("contacts.list"));
    expect(u.panelIds()).toEqual(["todos.list", "contacts.list"]);
    await stopContacts?.();
    expect(u.panelIds()).toEqual(["todos.list"]);
    await h.stop();
  });
});

// A second application on the same context reuses the running shell: an empty "shell" feature.
const shellFeatureStub = () => ({ id: "shell", bundles: [] });

describe("read-then-set", () => {
  it("setting a key after it was read throws; before, it overrides", () => {
    const context = {};
    const custom = createLogger(() => {});
    setLogger(context, custom);
    expect(getLogger(context)).toBe(custom);
    expect(() => setLogger(context, createLogger())).toThrow(/sys:logger was already read/);
    getStore(context);
    expect(() => setKey(context, "sys:store", {})).toThrow(/already read/);
  });

  it("a factory runs once on first resolution", () => {
    let made = 0;
    const [get] = newAdapter("x:thing", () => ++made);
    const context = {};
    expect(get(context)).toBe(1);
    expect(get(context)).toBe(1);
    expect(getKey(context, "x:thing")).toBe(1);
  });
});
