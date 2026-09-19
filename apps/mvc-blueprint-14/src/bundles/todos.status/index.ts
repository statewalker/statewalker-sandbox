import { headerSlot } from "@b/shell/api";
import { todosCollectionSlot } from "@b/todos/api";
import { type Controller, getSlots, newRegistry, useFields } from "@kernel";
import { createValue } from "@kit/model";
import { followFirst } from "@kit/slots";

const fields = useFields({ slots: getSlots });

/**
 * `todos.status`: the header item "N open todos", derived from the published `todos:collection`
 * read through the Todos API only. Shown while a collection exists — in whichever order the
 * collection's owner and this bundle activate.
 */
export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const [register, cleanup] = newRegistry();
  const state = createValue({ text: "" });
  register(() => state.dispose());
  const model = Object.freeze({ getState: state.get, onStateUpdate: state.on });
  register(
    followFirst(slots, todosCollectionSlot, (collection) => {
      const off = collection.onCountsUpdate(() =>
        state.set(Object.freeze({ text: `${collection.getCounts().open} open todos` })),
      );
      const withdraw = slots.provide(headerSlot, { id: "todos.status", order: 10, model });
      return () => {
        withdraw();
        off();
      };
    }),
  );
  return cleanup;
};
