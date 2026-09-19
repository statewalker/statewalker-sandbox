import type { ConfirmView } from "@p5/todos/api";
import type { ActionControl } from "@p5/kernel";
import { createAction } from "@p5/kit-model";

export interface ConfirmModel {
  readonly view: ConfirmView;
  readonly control: { readonly confirm: ActionControl; readonly cancel: ActionControl };
  dispose(): void;
}

/** A question with two answers. The question is fixed when asked. */
export function createConfirmModel(text: string, confirmLabel: string): ConfirmModel {
  const question = Object.freeze({ text });
  const confirm = createAction({ label: confirmLabel });
  const cancel = createAction({ label: "Cancel" });
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
