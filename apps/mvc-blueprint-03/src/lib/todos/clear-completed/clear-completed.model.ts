import type { ActionControl, ActionView } from "@sys/action/model";
import { defineViewKind } from "@sys/extension-points";

export interface ConfirmQuestion {
  readonly text: string;
  readonly count: number;
}

export interface ConfirmActions<A> {
  readonly ok: A;
  readonly cancel: A;
}

/** A question with two answers. The answers are actions: the dialog raises intents, the controller acts. */
export interface ConfirmView {
  getQuestion(): ConfirmQuestion;
  readonly actions: ConfirmActions<ActionView>;
}

export interface ConfirmControl {
  readonly actions: ConfirmActions<ActionControl>;
}

export interface ConfirmModel {
  readonly view: ConfirmView;
  readonly control: ConfirmControl;
  dispose(): void;
}

export const clearCompletedConfirmKind = defineViewKind<ConfirmView>(
  "todos:clear-completed:confirm",
);
