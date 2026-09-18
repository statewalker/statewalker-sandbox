import type { Chart } from "@kit/machine";

/**
 * The contact editor's chart — the same shape as `todos.edit`'s: `open` is entered afresh by every
 * `open` event; a `save` while `saving` has no rule and is dropped (REFUSED while running).
 */
export const contactEditorChart: Chart = {
  key: "contacts.edit",
  transitions: [
    ["", "*", "closed"],
    ["*", "open", "open"],
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
