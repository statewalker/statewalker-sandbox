import { Slots } from "@statewalker/shared-slots";
import { defineViewKind, panelsSlot, progressSlot } from "@sys/ui";
import { domRenderer, mountDomHost } from "@ui/dom";
import { afterEach, describe, expect, it } from "vitest";

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
const renderCounter = domRenderer(counterKind, (container, model) => {
  const span = document.createElement("span");
  container.appendChild(span);
  return model.onCountUpdate(() => {
    span.textContent = String(model.getCount());
  });
});

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function regions() {
  const main = document.createElement("div");
  const side = document.createElement("div");
  const progress = document.createElement("div");
  document.body.append(main, side, progress);
  cleanups.push(() => {
    main.remove();
    side.remove();
    progress.remove();
  });
  return { main, side, progress };
}

describe("B3 · DOM host", () => {
  it("loads no React — the project refuses to resolve it", async () => {
    // Through a variable, so Vite does not resolve it while transforming this file.
    // In the browser the plugin's message may arrive as a generic module-fetch
    // failure, so any rejection counts: without the plugin, "react" resolves.
    const load = (spec: string) => import(/* @vite-ignore */ spec);
    await expect(load("react")).rejects.toThrow();
  });

  it("renders a panel in its placement region, live, and removes it when the contribution is withdrawn", () => {
    const slots = new Slots();
    const r = regions();
    const host = mountDomHost({ slots, regions: { side: r.side }, renderers: [renderCounter] });
    cleanups.push(() => host.dispose());
    const model = counter();
    const off = slots.register(panelsSlot, "c", {
      kind: counterKind,
      title: "Counter",
      placement: "side",
      model,
    });
    const section = r.side.querySelector<HTMLElement>('[data-panel="c"]');
    expect(section?.getAttribute("aria-label")).toBe("Counter");
    expect(section?.textContent).toBe("0");
    model.increment();
    expect(section?.textContent).toBe("1");
    off();
    expect(r.side.querySelector('[data-panel="c"]')).toBeNull();
  });

  it("ignores kinds it has no renderer for, and placements it has no region for", () => {
    const slots = new Slots();
    const r = regions();
    const host = mountDomHost({ slots, regions: { side: r.side }, renderers: [renderCounter] });
    cleanups.push(() => host.dispose());
    slots.register(panelsSlot, "other", {
      kind: defineViewKind("demo:other"),
      title: "O",
      placement: "side",
      model: {},
    });
    slots.register(panelsSlot, "main", {
      kind: counterKind,
      title: "M",
      placement: "main",
      model: counter(),
    });
    expect(r.side.children).toHaveLength(0);
    expect(host.kinds()).toEqual(["demo:counter"]);
  });

  it("renders progress contributions into the progress region, and dispose removes everything", () => {
    const slots = new Slots();
    const r = regions();
    const host = mountDomHost({
      slots,
      regions: { side: r.side },
      progress: r.progress,
      renderers: [renderCounter],
    });
    slots.provide(progressSlot, { kind: counterKind, model: counter() });
    slots.register(panelsSlot, "c", {
      kind: counterKind,
      title: "C",
      placement: "side",
      model: counter(),
    });
    expect(r.progress.querySelectorAll('[data-progress="demo:counter"]')).toHaveLength(1);
    host.dispose();
    expect(r.progress.children).toHaveLength(0);
    expect(r.side.children).toHaveLength(0);
  });
});
