import { clearCompletedConfirmKind } from "@todos/clear-completed/model";
import { type ReactRenderer, reactRenderer } from "@ui/host";
import { ClearCompletedConfirm } from "./confirm-view.js";

export { ClearCompletedConfirm };
export const clearCompletedRenderers: readonly ReactRenderer[] = [
  reactRenderer(clearCompletedConfirmKind, ClearCompletedConfirm),
];
