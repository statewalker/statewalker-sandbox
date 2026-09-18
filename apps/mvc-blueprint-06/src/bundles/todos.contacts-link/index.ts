/**
 * `todos.contacts-link` — interaction (1): "New todo for this contact" in Contacts' selection
 * actions. Knows the Todos and Contacts APIs only; edits no file of Contacts.
 */
import {
  type ActionItem,
  type Behavior,
  type BundleManifest,
  contribute,
} from "../../kernel/index.js";
import { type Contact, selection, selectionActions } from "../contacts/api/index.js";
import { todosEdit } from "../todos/api/index.js";

type LinkMsg = { type: "new-todo" };
const ADDRESS = "todos.contacts-link";

const behavior: Behavior<LinkMsg> = (ctx) => {
  let selected: Contact | null = null;
  const item = (): ActionItem => ({
    order: 50,
    action: {
      id: "new-todo",
      label: "New todo for this contact",
      enabled: selected !== null,
      to: ADDRESS,
      msg: { type: "new-todo" },
    },
  });
  const action = contribute(ctx, selectionActions, "todos.contacts-link:new-todo", item());
  ctx.subscribe(selection, (s) => {
    selected = s ?? null;
    action.update(item());
  });
  return (msg) => {
    if (msg.type !== "new-todo" || !selected) return;
    // Commit time: the selection as this actor last received it, which (mailbox order) is the one
    // the user saw when clicking.
    ctx.pipe(
      ctx.ask(todosEdit, { type: "todos:compose", title: selected.name }),
      () => {},
      (e) => ctx.log.warn("todos:compose failed", e),
    );
  };
};

export const todosContactsLinkBundle: BundleManifest = { id: ADDRESS, behavior };
