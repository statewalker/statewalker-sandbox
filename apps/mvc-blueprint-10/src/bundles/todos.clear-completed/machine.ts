import type { Chart } from "@kit/machine";

/**
 * Clear completed: `ask` (carrying the ids done WHEN ASKED) enters `busy`, which holds the dialog
 * and keeps the action `running` until the answer is handled. An `ask` while busy has no rule and
 * is dropped: the action is REFUSED from the ask until the answer is handled. The dialog's answers
 * are listened to in `asking` only, so a `cancel` never reaches the machine while `clearing`.
 */
export const clearCompletedChart: Chart = {
  key: "todos.clear-completed",
  transitions: [
    ["", "*", "idle"],
    ["idle", "ask", "busy"],
    ["busy", "cancel", "idle"],
    ["busy", "done", "idle"],
  ],
  states: [
    { key: "idle" },
    {
      key: "busy",
      transitions: [
        ["", "*", "asking"],
        ["asking", "confirm", "clearing"],
      ],
      states: [{ key: "asking" }, { key: "clearing" }],
    },
  ],
};
