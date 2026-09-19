import { type Controller, getSlots, useFields } from "@p5/kernel";
import { createValue } from "@p5/kit-model";
import { followFirst } from "@p5/kit-slots";
import { headerSlot } from "@p5/shell/api";
import { todosCollectionSlot } from "@p5/todos/api";

const fields = useFields({ slots: getSlots });

/**
 * `todos.status`: the header item "N open todos", derived from the published `todos:collection`
 * read through the Todos API only. Shown while a collection exists — in whichever order the
 * collection's owner and this bundle activate.
 */
export const activate: Controller = async (context, scope) => {
  const { slots } = fields(context);
  const state = createValue({ text: "" });
  scope.defer(() => state.dispose());
  const model = Object.freeze({ getState: state.get, onStateUpdate: state.on });
  scope.defer(
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
};
