import { menuSlot, panelsSlot } from "@b/shell/api";
import { type ActionState, type Controller, getSlots, type Listener, useFields } from "@kernel";
import { type HelloView, helloKind } from "./api/index.js";

/** One group: a value, and listeners told synchronously, in order, isolated, when it changes. */
function group<T>(initial: T) {
  let value = initial;
  let live = true;
  const listeners = new Set<Listener>();
  const call = (l: Listener) => {
    try {
      l();
    } catch (error) {
      console.error(error);
    }
  };
  return {
    get: () => value,
    on(listener: Listener) {
      if (!live) return () => {};
      const entry = () => listener();
      listeners.add(entry);
      call(entry);
      return () => void listeners.delete(entry);
    },
    set(next: T) {
      if (!live || Object.is(next, value)) return;
      value = next;
      for (const l of [...listeners]) if (listeners.has(l)) call(l);
    },
    dispose() {
      live = false;
      listeners.clear();
    },
  };
}

const fields = useFields({ slots: getSlots });

/** The minimal bundle: one menu item and one panel; the action increments a counter. */
export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const count = group(0);
  const submits = group(0);
  const state = group<ActionState>(
    Object.freeze({ label: "Say hello", enabled: true, running: false }),
  );
  const view: HelloView = Object.freeze({
    getCount: count.get,
    onCountUpdate: count.on,
    increment: Object.freeze({
      getState: state.get,
      onStateUpdate: state.on,
      submit: () => submits.set(submits.get() + 1),
    }),
  });
  // The controller: the only writer of `count`.
  const off = submits.on(() => count.set(submits.get()));
  const withdrawPanel = slots.register(panelsSlot, "hello", {
    kind: helloKind,
    title: "Hello",
    placement: "main",
    order: 90,
    model: view,
  });
  const withdrawMenu = slots.provide(menuSlot, {
    id: "hello.say",
    group: "hello",
    groupLabel: "Hello",
    order: 10,
    action: view.increment,
  });
  return () => {
    withdrawMenu();
    withdrawPanel();
    off();
    for (const g of [count, submits, state]) g.dispose();
  };
};
