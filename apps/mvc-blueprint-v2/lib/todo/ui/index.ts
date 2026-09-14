import { confirmDialogKind, todoListKind } from "@todo/models";
import { reactRenderer } from "@ui/react";
import { ConfirmView } from "./confirm-view.js";
import { ListView, SAMPLE_COUNT } from "./list-view.js";

export { ConfirmView, ListView, SAMPLE_COUNT };

export const todoRenderers = [
  reactRenderer(todoListKind, ListView),
  reactRenderer(confirmDialogKind, ConfirmView),
];
