/**
 * The kernel's model module (§6): shared model shapes every API module may use. Declarations only,
 * plus `defineViewKind`, a declaration helper like `defineSlot`.
 */
export interface ActionState {
  readonly label: string;
  readonly icon?: string;
  readonly hint?: string;
  /** base flag AND the owner's derived guard */
  readonly enabled: boolean;
  /** an intent this action appended has no outcome yet */
  readonly running: boolean;
}

/** In R3 an action's `submit()` appends an intent record; there is no submit edge to drain. */
export interface ActionView {
  getState(): ActionState;
  onStateUpdate(listener: () => void): () => void;
  /** ignored while disabled, while running (for "refuse" actions) and after dispose */
  submit(): void;
}

/** A contribution to an action list (toolbar, selection actions). */
export interface ActionEntry {
  readonly id: string;
  readonly order: number;
  readonly action: ActionView;
}

/** A view kind carries the model type for typed renderers. */
export interface ViewKind<M> {
  readonly id: string;
  readonly _model?: M;
}
export const defineViewKind = <M>(id: string): ViewKind<M> => Object.freeze({ id });

/** Sorting helper for `{ order, id }` contributions. */
export const byOrder = <T extends { order?: number; id: string }>(a: T, b: T) =>
  (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
