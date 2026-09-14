import { Slots } from "@statewalker/shared-slots";
import { defineViewKind, dialogsSlot, panelsSlot } from "@sys/ui";
import { mountReactHost, reactRenderer, useModel } from "@ui/react";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(host.kinds()).toEqual(["demo:counter", "demo:dialog"]);
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
