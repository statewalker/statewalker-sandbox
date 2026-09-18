/** `contacts.ui.react` — contributes the Contacts renderers to the React host. */
import { type BundleManifest, contribute } from "../../kernel/index.js";
import { detailsKind, editorKind, listKind } from "../contacts/api/index.js";
import { reactRenderers } from "../shell/api/react.js";
import { ContactEditorView, ContactsListView, DetailsView } from "./views.js";

export const contactsUiReactBundle: BundleManifest = {
  id: "contacts.ui.react",
  behavior: (ctx) => {
    contribute(ctx, reactRenderers, listKind.id, {
      kind: listKind.id,
      component: ContactsListView,
    });
    contribute(ctx, reactRenderers, detailsKind.id, {
      kind: detailsKind.id,
      component: DetailsView,
    });
    contribute(ctx, reactRenderers, editorKind.id, {
      kind: editorKind.id,
      component: ContactEditorView,
    });
    return () => {};
  },
};
