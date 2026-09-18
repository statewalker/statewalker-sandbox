/**
 * `contacts.list` — the list panel and, while a contact is selected, its details panel. Owns
 * `contacts:selection` and the `contacts:selection-actions` point (rendered in the details panel).
 */
import {
  type ActionItem,
  type Behavior,
  type BundleManifest,
  type Contributed,
  contribute,
  defineStream,
  ownPoints,
} from "../../kernel/index.js";
import {
  type Contact,
  type ContactsListMsg,
  type ContactsListState,
  type DetailsState,
  detailsKind,
  directory,
  listKind,
  selection,
  selectionActions,
} from "../contacts/api/index.js";
import { type Panel, panels } from "../shell/api/index.js";

const ADDRESS = "contacts.list";
const listView = defineStream<ContactsListState>("contacts.list:view");
const detailsView = defineStream<DetailsState>("contacts.list:details");

const behavior: Behavior<ContactsListMsg> = (ctx) => {
  const points = ownPoints(ctx, [selectionActions]);
  let contacts: readonly Contact[] = [];
  let selectedId: string | null = null;
  let actions: readonly ActionItem[] = [];
  let details: Contributed<Panel> | undefined;

  const render = () => {
    const selected = contacts.find((c) => c.id === selectedId) ?? null;
    if (!selected) selectedId = null;
    ctx.publish(selection, selected);
    ctx.publish(listView, { contacts: contacts.map(({ id, name }) => ({ id, name })), selectedId });
    if (selected) {
      ctx.publish(detailsView, { contact: selected, actions });
      const value: Panel = {
        kind: detailsKind.id,
        stream: detailsView,
        inbox: ADDRESS,
        title: selected.name,
        placement: "side",
        order: 0,
      };
      if (details) details.update(value);
      else details = contribute(ctx, panels, "contacts:details", value);
    } else {
      details?.withdraw();
      details = undefined;
    }
  };
  ctx.subscribe(directory, (d) => {
    contacts = d ?? [];
    render();
  });
  ctx.subscribe(selectionActions.key, (items) => {
    actions = (items ?? []).map((c) => c.value);
    render();
  });
  render();
  contribute(ctx, panels, "contacts:list", {
    kind: listKind.id,
    stream: listView,
    inbox: ADDRESS,
    title: "Contacts",
    placement: "main",
    order: 10,
  });

  return (msg, env) => {
    if (points.handle(msg, env)) return;
    if (msg.type === "select") {
      selectedId = msg.id;
      render();
    }
  };
};

export const contactsListBundle: BundleManifest = { id: ADDRESS, behavior };
