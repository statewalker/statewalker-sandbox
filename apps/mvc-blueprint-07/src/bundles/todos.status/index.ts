import { type Controller, useFields } from "../../kernel/context.js";
import { getSlots } from "../../kernel/slots.js";
import { derived } from "../../kit/cell.js";
import { followSlot } from "../../kit/follow.js";
import { type HeaderItemView, headerSlot } from "../shell/api/index.js";
import { collectionSlot } from "../todos/api/index.js";

const fields = useFields({ slots: getSlots });

/** "N open todos" in the header — derived from the published collection; no intent involved. */
export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const counts = followSlot(
    slots,
    collectionSlot,
    (c) => ({ get: c.getCounts, subscribe: c.onCountsUpdate }),
    { open: 0, done: 0 },
  );
  const state = derived([counts], () => ({ text: `${counts.get().open} open todos` }));
  const model: HeaderItemView = Object.freeze({
    getState: state.get,
    onStateUpdate: state.subscribe,
  });
  // Shown only while the collection exists: before its owner arrives there is no count to state.
  let unpublish: (() => void) | undefined;
  const offPresent = counts.present.subscribe(() => {
    if (counts.present.get() && !unpublish) {
      unpublish = slots.provide(headerSlot, { id: "todos.status", order: 10, model });
    } else if (!counts.present.get() && unpublish) {
      unpublish();
      unpublish = undefined;
    }
  });
  return () => {
    offPresent();
    unpublish?.();
    state.dispose();
    counts.dispose();
  };
};
