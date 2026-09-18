/**
 * The kernel's model module: the types every API module may use. Declarations only.
 */

export type Listener = () => void;
export type Unsubscribe = () => void;

/** A view kind carries the model type its renderers receive. */
export interface ViewKind<M> {
  readonly id: string;
  /** Phantom: never set. */
  readonly _model?: M;
}

export function defineViewKind<M>(id: string): ViewKind<M> {
  return Object.freeze({ id });
}

/** What a button or a menu item renders. `enabled` already includes the owner's derived guard. */
export interface ActionState {
  readonly label: string;
  readonly icon?: string;
  readonly hint?: string;
  readonly enabled: boolean;
  readonly running: boolean;
}

/** The view's side of an action: read it, and raise the intent. */
export interface ActionView {
  getState(): ActionState;
  onStateUpdate(listener: Listener): Unsubscribe;
  /** Raises the intent. Ignored while disabled, after dispose, and — unless queued — while running. */
  submit(): void;
}

/** The controller's side: observe intents, describe the action. */
export interface ActionControl {
  /** Monotonic count of accepted submits (a state-latest edge). */
  getSubmits(): number;
  onSubmitsUpdate(listener: Listener): Unsubscribe;
  /** Patch; an undefined field is left unchanged. `enabled` sets the base flag only. */
  update(patch: Partial<ActionState>): void;
}

/** An action offered at an extension point: a toolbar, a selection menu. */
export interface ActionContribution {
  readonly id: string;
  readonly order: number;
  readonly action: ActionView;
}
