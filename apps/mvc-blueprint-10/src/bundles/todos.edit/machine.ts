import type { Chart } from "@kit/machine";

/**
 * The editor's chart. `open` is entered afresh by every `edit` / `compose` (a new session replaces
 * the old one); inside it Save moves `editing → saving`. A `save` while saving has no rule, so the
 * machine drops it: Save is REFUSED while running. `cancel` or a replacing `edit` during `saving`
 * leaves the state, and the save's result is dropped with it (the write itself still lands).
 */
export const editorChart: Chart = {
  key: "todos.edit",
  transitions: [
    ["", "*", "closed"],
    ["*", "edit", "open"],
    ["*", "compose", "open"],
    ["open", "cancel", "closed"],
    ["open", "saved", "closed"],
  ],
  states: [
    { key: "closed" },
    {
      key: "open",
      transitions: [
        ["", "*", "editing"],
        ["editing", "save", "saving"],
        ["saving", "failed", "editing"],
      ],
      states: [{ key: "editing" }, { key: "saving" }],
    },
  ],
};

/** The data an `edit` / `compose` event carries. */
export interface OpenEditor {
  readonly mode: "edit" | "create";
  readonly title: string;
  readonly id?: string;
}
