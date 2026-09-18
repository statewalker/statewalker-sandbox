/**
 * todos.contacts-link — interaction (1): "New todo for this contact" in Contacts' selection
 * actions. Reads the selection when its message is processed (commit time) and dispatches
 * Todos' public `todos/compose`. Imports two API modules; edits nothing in Contacts.
 *
 * It needs an update function to read the selection at commit time, so it registers a slice with
 * no state worth the name — the price of "only updates act on messages".
 */
import {
  type Activator,
  defineMsg,
  dispatchFx,
  disposers,
  getStore,
  next,
  useFields,
} from "../../kernel/index.ts";
import { contactsSelection, contactsSelectionActions } from "../contacts/api/index.ts";
import { todosCompose } from "../todos/api/index.ts";

const newTodo = defineMsg("todos.contacts-link/new-todo");
type LinkState = Record<string, never>;

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);
  const slice = store.addSlice<LinkState>({
    id: "todos.contacts-link",
    init: () => ({}),
    update(state, msg, { select }) {
      if (!newTodo.match(msg)) return state;
      const contact = select(contactsSelection)[0]?.selected;
      return contact ? next(state, dispatchFx(todosCompose({ title: contact.name }))) : state;
    },
  });
  return disposers(
    slice.contribute(contactsSelectionActions, "todos.contacts-link", (_state, select) => [
      {
        id: "todos.new-for-contact",
        order: 50,
        label: "New todo for this contact",
        enabled: !!select(contactsSelection)[0]?.selected,
        msg: newTodo(),
      },
    ]),
    slice.dispose,
  );
};
