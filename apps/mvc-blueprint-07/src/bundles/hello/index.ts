import type { Controller } from "../../kernel/context.js";
import { defineEvent, openLog } from "../../kernel/log.js";
import type { ActionState, ActionView } from "../../kernel/models.js";
import { getSlots } from "../../kernel/slots.js";
import { menuSlot, panelsSlot } from "../shell/api/index.js";
import { type HelloView, helloKind } from "./api/index.js";

/** The minimal bundle (§13.1), kernel only: an event, a fold, a hand-rolled model, two contributions. */
const increment = defineEvent("hello:increment");

export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const log = openLog(context, "hello");
  let state = { count: 0 };
  const listeners = new Set<() => void>();
  const offFold = log.project((record) => {
    if (record.type !== increment.id) return;
    state = { count: state.count + 1 };
    for (const listener of [...listeners]) listener();
  });
  const actionState: ActionState = { label: "Increment", enabled: true, running: false };
  const action: ActionView = Object.freeze({
    getState: () => actionState,
    onStateUpdate(listener: () => void) {
      listener(); // the label never changes; one immediate call honours contract point 1
      return () => {};
    },
    submit: () => void (!log.closed && log.append(increment, undefined)),
  });
  const model: HelloView = Object.freeze({
    getState: () => state,
    onStateUpdate(listener: () => void) {
      listeners.add(listener);
      listener();
      return () => void listeners.delete(listener);
    },
    increment: action,
  });
  const offs = [
    slots.provide(menuSlot, { id: "hello", group: "hello", groupLabel: "Hello", order: 0, action }),
    slots.register(panelsSlot, "hello", {
      kind: helloKind,
      title: "Hello",
      placement: "main",
      order: 20,
      model,
    }),
  ];
  return () => {
    for (const off of offs) off();
    offFold();
    listeners.clear();
    log.close();
  };
};
