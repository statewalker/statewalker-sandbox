/** todos.status — the header item "N open todos". No state of its own: a pure derivation. */
import { type Activator, getStore, useFields } from "../../kernel/index.ts";
import { shellHeader } from "../shell/api/index.ts";
import { todosCollection } from "../todos/api/index.ts";

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);
  return store.contribute(shellHeader, "todos.status", (select) =>
    select(todosCollection).map(({ counts }) => ({
      id: "todos.status",
      order: 10,
      text: `${counts.open} open todos`,
    })),
  );
};
