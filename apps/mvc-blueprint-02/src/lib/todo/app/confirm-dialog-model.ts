import { signal, untracked } from "@signals";
import type { ConfirmDialogControl, ConfirmDialogModel, ConfirmDialogView } from "./models.js";
import { newChannels } from "./signal-model.js";

/** One question, one answer. Its lifetime is its `ui:dialogs` contribution. */
export function createConfirmDialogModel(question: string): ConfirmDialogModel {
  const answer = signal<boolean | undefined>(undefined);
  let taken = false;
  const ch = newChannels();
  const view: ConfirmDialogView = Object.freeze({
    getQuestion: () => question,
    answer: (confirmed: boolean) => {
      if (ch.disposed || untracked(() => answer()) !== undefined) return;
      answer(confirmed);
    },
  });
  const control: ConfirmDialogControl = Object.freeze({
    onAnswerUpdate: ch.channel(() => answer()),
    takeAnswer: () => {
      if (ch.disposed) return undefined;
      const value = untracked(() => answer());
      if (taken || value === undefined) return undefined;
      taken = true;
      return value;
    },
  });
  return Object.freeze({ view, control, dispose: () => ch.dispose() });
}
