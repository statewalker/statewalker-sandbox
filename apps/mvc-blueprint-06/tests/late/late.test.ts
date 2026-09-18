/** Late subscribers and arrival order — with no retained slots, only streams and presence. */
import { describe, expect, it } from "vitest";
import { todosStatusBundle } from "../../src/bundles/todos.status/index.js";
import { contactsFeature, shellFeature, todosFeature } from "../../src/features.js";
import { application, type FeatureManifest } from "../../src/kernel/index.js";
import { titles } from "../scenario/scenario.js";
import { start, waitFor } from "../support/headless.js";

const noRequires = (f: FeatureManifest): FeatureManifest => ({ ...f, requires: [] });

describe("late subscriber", () => {
  it("todos.status activated BEFORE todos.core still shows the count", async () => {
    const h = await start({
      id: "status-first",
      features: [
        shellFeature,
        { id: "status", bundles: [todosStatusBundle] },
        noRequires(todosFeature()),
      ],
    });
    await waitFor(() => h.headerTexts().includes("2 open todos"));
    expect(h.errors()).toEqual([]);
    await h.stop();
  });

  it("every contributor activated BEFORE the shell is seen once the shell starts", async () => {
    const h = await start({
      id: "shell-last",
      features: [noRequires(todosFeature()), noRequires(contactsFeature()), shellFeature],
    });
    await waitFor(() => titles(h).length === 3);
    expect(h.panelIds()).toEqual(expect.arrayContaining(["todos:list", "contacts:list"]));
    expect(h.menuGroups()).toEqual(expect.arrayContaining(["Todos", "Contacts"]));
    expect(h.errors()).toEqual([]);
    await h.stop();
  });

  it("a feature activated after the shell appears without a reload, and leaves cleanly", async () => {
    const h = await start({ id: "todos-only", features: [shellFeature, todosFeature()] });
    await waitFor(() => titles(h).length === 3);
    expect(h.menuGroups()).toEqual(["Todos"]);
    const stopContacts = await application({
      id: "contacts-later",
      features: [noRequires(contactsFeature())],
    })(h.system);
    expect(h.menuGroups()).toEqual(["Todos", "Contacts"]);
    expect(h.panelIds()).toContain("contacts:list");
    await stopContacts();
    expect(h.menuGroups()).toEqual(["Todos"]);
    expect(h.panelIds()).not.toContain("contacts:list");
    expect(h.errors()).toEqual([]);
    await h.stop();
  });
});
