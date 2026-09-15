/** What a button or a menu item renders. `enabled` already includes the owner's guard. */
export interface ActionState {
  readonly label: string;
  readonly icon?: string;
  readonly hint?: string;
  readonly enabled: boolean;
  readonly running: boolean;
}

/** The UI's side of an action: read it, and raise the intent. */
export interface ActionView {
  getState(): ActionState;
  onStateUpdate(listener: () => void): () => void;
  /** Raises the intent. Ignored while disabled, while running, and after dispose. */
  submit(): void;
}

/** The controller's side: observe intents, and say what the action looks like now. */
export interface ActionControl {
  /** A monotonic count of accepted submits — a state-latest edge. */
  getSubmits(): number;
  onSubmitsUpdate(listener: () => void): () => void;
  /** Patch: an undefined field leaves the value unchanged. `enabled` sets the base flag. */
  update(patch: Partial<ActionState>): void;
}

/**
 * An intent without a payload. The data an intent needs lives in the model the
 * action belongs to (a list's selection, a form's draft); the action only says
 * "do it", and carries what a button, a toolbar or a menu needs to render.
 */
export interface ActionModel {
  readonly view: ActionView;
  readonly control: ActionControl;
  dispose(): void;
}
