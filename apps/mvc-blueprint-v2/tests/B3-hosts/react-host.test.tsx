import { Slots } from "@statewalker/shared-slots";
import { defineViewKind, dialogsSlot, panelsSlot, progressSlot } from "@sys/ui";
import { domRenderer, mountDomHost } from "@ui/dom";
import { mountReactHost, reactRenderer, useModel } from "@ui/react";
import { afterEach, describe, expect, it } from "vitest";
import { observeCoverage, type Unrendered } from "../../src/coverage.js";
import { waitFor } from "../support/react.js";

interface Counter {
  getCount(): number;
  onCountUpdate(l: () => void): () => void;
  increment(): void;
}

function counter(): Counter {
  let count = 0;
  const listeners = new Set<() => void>();
  return {
    getCount: () => count,
    onCountUpdate: (l) => {
      listeners.add(l);
      l();
      return () => listeners.delete(l);
    },
    increment: () => {
      count++;
      for (const l of [...listeners]) l();
    },
  };
}

const counterKind = defineViewKind<Counter>("demo:counter");
function CounterView({ model }: { model: Counter }) {
  const count = useModel(model.getCount, model.onCountUpdate);
  return <output>{count}</output>;
}
const dialogKind = defineViewKind<object>("demo:dialog");
function DialogView() {
  return <button type="button">Inside the dialog</button>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const main = document.createElement("div");
  const dialogs = document.createElement("div");
  document.body.append(main, dialogs);
  const slots = new Slots();
  const host = mountReactHost({
    slots,
    regions: { main },
    dialogs,
    renderers: [reactRenderer(counterKind, CounterView), reactRenderer(dialogKind, DialogView)],
  });
  cleanups.push(() => {
    host.dispose();
    main.remove();
    dialogs.remove();
  });
  return { slots, host, main, dialogs };
}

describe("B3 · React host", () => {
  it("renders a panel by kind, re-renders through useModel, and unmounts it when withdrawn", async () => {
    const { slots, main, host } = setup();
    const model = counter();
    const off = slots.register(panelsSlot, "c", {
      kind: counterKind,
      title: "Counter",
      placement: "main",
      model,
    });
    await waitFor(() => main.querySelector('[data-panel="c"] output')?.textContent === "0");
    expect(main.querySelector('[data-panel="c"]')?.getAttribute("aria-label")).toBe("Counter");
    model.increment();
    await waitFor(() => main.querySelector('[data-panel="c"] output')?.textContent === "1");
    off();
    await waitFor(() => main.querySelector('[data-panel="c"]') === null);
  });

  it("renders() is true only where it has a renderer for the kind AND a place for it", () => {
    const { host } = setup();
    const other = defineViewKind("demo:other");
    expect(host.renders("ui:panels", { kind: counterKind, placement: "main" })).toBe(true);
    expect(
      host.renders("ui:panels", { kind: counterKind, placement: "side" }),
      "no side region",
    ).toBe(false);
    expect(host.renders("ui:panels", { kind: other, placement: "main" }), "no renderer").toBe(
      false,
    );
    expect(host.renders("ui:dialogs", { kind: dialogKind })).toBe(true);
    expect(host.renders("ui:progress", { kind: counterKind }), "it renders no progress").toBe(
      false,
    );
    const bare = mountReactHost({
      slots: new Slots(),
      regions: {},
      renderers: [reactRenderer(dialogKind, DialogView)],
    });
    cleanups.push(() => bare.dispose());
    expect(bare.renders("ui:dialogs", { kind: dialogKind }), "no dialogs container").toBe(false);
  });

  it("with both real hosts, coverage reports a known kind no host has a place for", async () => {
    const { slots, host, main } = setup();
    const side = document.createElement("div");
    const progress = document.createElement("div");
    document.body.append(side, progress);
    const barKind = defineViewKind<object>("demo:bar");
    const dom = mountDomHost({
      slots,
      regions: { side },
      progress,
      renderers: [domRenderer(barKind, () => () => {})],
    });
    const reports: Unrendered[] = [];
    const off = observeCoverage(slots, [host, dom], (u) => reports.push(u));
    cleanups.push(() => {
      off();
      dom.dispose();
      side.remove();
      progress.remove();
    });

    slots.register(panelsSlot, "shown", {
      kind: counterKind,
      title: "Shown",
      placement: "main",
      model: counter(),
    });
    slots.provide(progressSlot, { kind: barKind, model: {} });
    slots.provide(dialogsSlot, { kind: dialogKind, model: {} });
    expect(reports, "everything so far has a renderer and a place").toEqual([]);

    // React renders the kind but has no side region; the DOM host has the region but no renderer.
    slots.register(panelsSlot, "lost", {
      kind: counterKind,
      title: "Lost",
      placement: "side",
      model: counter(),
    });
    // The DOM host renders the kind, but only as progress; the React host has no renderer for it.
    slots.provide(dialogsSlot, { kind: barKind, model: {} });
    expect(reports).toEqual([
      { slot: "ui:panels", kind: "demo:counter", placement: "side" },
      { slot: "ui:dialogs", kind: "demo:bar" },
    ]);
    await waitFor(() => main.querySelector('[data-panel="shown"] output') !== null);
    expect(side.children, "and indeed nothing reached the side region").toHaveLength(0);
  });

  it("renders dialogs, and returns focus to where it was when a focused dialog is removed", async () => {
    const { slots, dialogs } = setup();
    const opener = document.createElement("button");
    opener.textContent = "Opener";
    document.body.appendChild(opener);
    cleanups.push(() => opener.remove());
    opener.focus();
    const off = slots.provide(dialogsSlot, { kind: dialogKind, model: {} });
    await waitFor(() => dialogs.querySelector('[data-dialog="demo:dialog"] button') !== null);
    dialogs.querySelector<HTMLButtonElement>("button")?.focus();
    expect(document.activeElement?.textContent).toBe("Inside the dialog");
    off();
    await waitFor(() => document.activeElement === opener);
  });
});
