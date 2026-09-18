/** `todos.ui.react` — contributes the Todos renderers to the React host. Wiring only. */
import { type BundleManifest, contribute } from "../../kernel/index.js";
import { reactRenderers } from "../shell/api/react.js";
import { clearCompletedKind, editorKind, listKind } from "../todos/api/index.js";
import { ClearCompletedView, EditorView, ListView } from "./views.js";

export const todosUiReactBundle: BundleManifest = {
  id: "todos.ui.react",
  behavior: (ctx) => {
    contribute(ctx, reactRenderers, listKind.id, { kind: listKind.id, component: ListView });
    contribute(ctx, reactRenderers, editorKind.id, { kind: editorKind.id, component: EditorView });
    contribute(ctx, reactRenderers, clearCompletedKind.id, {
      kind: clearCompletedKind.id,
      component: ClearCompletedView,
    });
    return () => {};
  },
};
