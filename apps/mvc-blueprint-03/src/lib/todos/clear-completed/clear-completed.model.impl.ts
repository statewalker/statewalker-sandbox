import { newRegistry } from "@statewalker/shared-registry";
import { type ActionModel, createAction } from "@sys/action";
import { signal } from "@sys/signals";
import type {
  ConfirmControl,
  ConfirmModel,
  ConfirmQuestion,
  ConfirmView,
} from "./clear-completed.model.js";

export function createConfirmModel(question: ConfirmQuestion): ConfirmModel {
  const [register, cleanup] = newRegistry();
  let disposed = false;
  const alive = signal(true);
  const own = (model: ActionModel): ActionModel => {
    register(() => model.dispose());
    return model;
  };
  const ok = own(createAction({ label: "Clear", icon: "trash-2", when: () => alive() }));
  const cancel = own(createAction({ label: "Cancel", icon: "x", when: () => alive() }));
  const frozen: ConfirmQuestion = Object.freeze({ text: question.text, count: question.count });

  const view: ConfirmView = Object.freeze({
    getQuestion: () => frozen,
    actions: Object.freeze({ ok: ok.view, cancel: cancel.view }),
  });
  const control: ConfirmControl = Object.freeze({
    actions: Object.freeze({ ok: ok.control, cancel: cancel.control }),
  });
  return Object.freeze({
    view,
    control,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      alive(false);
      void cleanup();
    },
  });
}
