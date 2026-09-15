import type { ActionControl, ActionView } from "@sys/action/model";
import { defineViewKind } from "@sys/extension-points";
import type { Todo } from "@todos/core";

export type { Todo };

export interface TodoDraft {
  readonly title: string;
  readonly done: boolean;
}

export interface FormStatus {
  readonly dirty: boolean;
  readonly valid: boolean;
  /** Present while the last save failed. */
  readonly error?: string;
}

/** The todo as it is saved. */
export interface TodoDetailsView {
  getTodo(): Todo;
  onTodoUpdate(listener: () => void): () => void;
}

export interface EditActions<A> {
  readonly save: A;
  readonly cancel: A;
}

/** The form: the draft the user changes, its status, and the intents to save or cancel it. */
export interface TodoFormView {
  getDraft(): TodoDraft;
  onDraftUpdate(listener: () => void): () => void;
  getStatus(): FormStatus;
  onStatusUpdate(listener: () => void): () => void;
  setTitle(title: string): void;
  setDone(done: boolean): void;
  readonly actions: EditActions<ActionView>;
}

export interface EditView {
  readonly details: TodoDetailsView;
  readonly form: TodoFormView;
}

export interface EditControl {
  reportError(message: string | undefined): void;
  /** The saved todo becomes the baseline: the draft is reset to it and the error cleared. */
  markSaved(todo: Todo): void;
  readonly actions: EditActions<ActionControl>;
}

export interface EditModel {
  readonly view: EditView;
  readonly control: EditControl;
  dispose(): void;
}

export const todoEditKind = defineViewKind<EditView>("todos:edit");
