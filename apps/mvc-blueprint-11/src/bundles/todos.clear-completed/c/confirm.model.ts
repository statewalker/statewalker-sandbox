import type { ConfirmView } from "@b/todos/api";
import { type CommitControl, createCommitAction } from "@kit/commit";

export interface ConfirmModel {
  readonly view: ConfirmView;
  readonly control: {
    readonly confirm: CommitControl<undefined>;
    readonly cancel: CommitControl<undefined>;
  };
  dispose(): void;
}

/** A question with two answers. The question is fixed when asked. */
export function createConfirmModel(text: string, confirmLabel: string): ConfirmModel {
  const question = Object.freeze({ text });
  const confirm = createCommitAction({ label: confirmLabel, capture: () => undefined });
  const cancel = createCommitAction({ label: "Cancel", capture: () => undefined });
  return Object.freeze({
    view: Object.freeze({
      getQuestion: () => question,
      confirm: confirm.view,
      cancel: cancel.view,
    }),
    control: Object.freeze({ confirm: confirm.control, cancel: cancel.control }),
    dispose: () => {
      confirm.dispose();
      cancel.dispose();
    },
  });
}
