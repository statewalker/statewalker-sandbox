import { Slots } from "@statewalker/shared-slots";
import { defineViewKind, dialogsSlot, notificationsSlot, panelsSlot } from "@sys/extension-points";
import { mountReactHost, observeCoverage, reactRenderer, type Unrendered, useSlot } from "@ui/host";
import { describe, expect, it } from "vitest";
import { createHost, flush, waitFor } from "../support/react.js";

interface Note {
  readonly text: string;
}
const noteKind = defineViewKind<Note>("test:note");
const orphanKind = defineViewKind<Note>("test:orphan");

function NoteView({ model }: { model: Note }) {
  const count = useSlot(notificationsSlot).length; // renderers can read slots through the host's provider
  return <p data-count={count}>{model.text}</p>;
}

function setup() {
  const slots = new Slots();
  const main = createHost();
  const side = createHost();
  const dialogs = createHost();
  const notifications = createHost();
  const host = mountReactHost({
    slots,
    regions: { main, side },
    dialogs,
    notifications,
    renderers: [reactRenderer(noteKind, NoteView)],
  });
  return { slots, main, side, dialogs, notifications, host };
}

describe("B3 · React host", () => {
  it("renders a panel in its placement's region, live, and removes it when withdrawn", async () => {
    const { slots, main, side, host } = setup();
    const off = slots.register(panelsSlot, "p1", {
      kind: noteKind,
      title: "Notes",
      placement: "side",
      model: { text: "hello" },
    });
    await waitFor(() => side.querySelector('[data-panel="p1"]') !== null);
    expect(side.querySelector('[data-panel="p1"]')?.getAttribute("aria-label")).toBe("Notes");
    expect(side.textContent).toContain("hello");
    expect(main.textContent).toBe("");
    off();
    await waitFor(() => side.querySelector('[data-panel="p1"]') === null);
    host.dispose();
  });

  it("renders dialogs and notifications in their containers, and gives renderers the slots", async () => {
    const { slots, dialogs, notifications, host } = setup();
    slots.provide(dialogsSlot, { kind: noteKind, model: { text: "a question" } });
    slots.provide(notificationsSlot, { kind: noteKind, model: { text: "one" } });
    slots.provide(notificationsSlot, { kind: noteKind, model: { text: "two" } });
    await waitFor(() => dialogs.querySelector('[data-dialog="test:note"]') !== null);
    await waitFor(
      () => notifications.querySelectorAll('[data-notification="test:note"]').length === 2,
    );
    expect(notifications.querySelector("p")?.getAttribute("data-count")).toBe("2");
    host.dispose();
  });

  it("renders() answers by slot, kind and placement", () => {
    const { host } = setup();
    expect(host.renders(panelsSlot.key, { kind: noteKind, placement: "main" })).toBe(true);
    expect(host.renders(panelsSlot.key, { kind: orphanKind, placement: "main" })).toBe(false);
    expect(host.renders(dialogsSlot.key, { kind: noteKind })).toBe(true);
    expect(host.renders(notificationsSlot.key, { kind: noteKind })).toBe(true);
    expect(host.renders("actions:todos.toolbar", { kind: noteKind })).toBe(false);
    const bare = mountReactHost({
      slots: new Slots(),
      regions: {},
      renderers: [reactRenderer(noteKind, NoteView)],
    });
    expect(bare.renders(panelsSlot.key, { kind: noteKind, placement: "side" })).toBe(false);
    expect(bare.renders(dialogsSlot.key, { kind: noteKind })).toBe(false);
    host.dispose();
    bare.dispose();
  });

  it("dispose unmounts every region", async () => {
    const { slots, main, host } = setup();
    slots.register(panelsSlot, "p", {
      kind: noteKind,
      title: "N",
      placement: "main",
      model: { text: "x" },
    });
    await waitFor(() => main.textContent === "x");
    host.dispose();
    await flush();
    await flush();
    expect(main.textContent).toBe("");
  });

  it("the coverage observer reports what no host renders, once per slot, kind and placement", () => {
    const { slots, host } = setup();
    const reported: Unrendered[] = [];
    const stop = observeCoverage(slots, [host], (u) => reported.push(u));
    slots.register(panelsSlot, "ok", {
      kind: noteKind,
      title: "ok",
      placement: "main",
      model: { text: "" },
    });
    slots.register(panelsSlot, "o1", {
      kind: orphanKind,
      title: "o",
      placement: "main",
      model: { text: "" },
    });
    slots.provide(dialogsSlot, { kind: orphanKind, model: { text: "" } });
    slots.provide(notificationsSlot, { kind: orphanKind, model: { text: "" } });
    slots.provide(notificationsSlot, { kind: orphanKind, model: { text: "again" } });
    expect(reported).toEqual([
      { slot: "ui:panels", kind: "test:orphan", placement: "main" },
      { slot: "ui:dialogs", kind: "test:orphan" },
      { slot: "ui:notifications", kind: "test:orphan" },
    ]);
    stop();
    host.dispose();
  });
});
