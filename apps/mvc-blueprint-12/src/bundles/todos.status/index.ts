import { headerSlot, type HeaderItemState } from "@b/shell/api";
import { todosCollectionSlot } from "@b/todos/api";
import { type Controller, getSlots, newRegistry, readable, useFields } from "@kernel";
import { stableGroup } from "@kit/model";
import { firstOf, followFirst } from "@kit/slots";

const fields = useFields({ slots: getSlots });

/**
 * `todos.status`: the header item "N open todos". P4: the text is derived (a `computed`) over the
 * collection's `counts`, read on the shared substrate — no listener, no copy. Shown while a
 * collection exists, in whichever order the collection's owner and this bundle activate.
 */
export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const [register, cleanup] = newRegistry();
  let active = true;
  const [collection, stop] = firstOf(slots, todosCollectionSlot);
  register(stop);
  const state = readable(
    stableGroup(
      (): HeaderItemState => ({ text: `${collection()?.counts().open ?? 0} open todos` }),
    ),
    () => active,
  );
  const model = Object.freeze({ getState: state, onStateUpdate: state.subscribe });
  // A view exists exactly as long as its publication: the item is published while a collection is.
  register(
    followFirst(slots, todosCollectionSlot, () =>
      slots.provide(headerSlot, { id: "todos.status", order: 10, model }),
    ),
  );
  register(() => {
    active = false;
  });
  return cleanup;
};
