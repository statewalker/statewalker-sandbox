/**
 * Shared DATA shapes of the kernel — no behaviour. Everything here is structured-cloneable.
 */

/**
 * An action, as data: what a view shows, and the message a view sends to submit it. The owner
 * re-sends the description whenever label, enabled or running change. There is no ActionView
 * object: submitting is `send(action.to, action.msg)`, done by the host's `dispatch`.
 */
export interface ActionDesc {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly running?: boolean;
  readonly to: string;
  readonly msg: unknown;
}

/** An action placed in an action list (toolbar, selection actions, …). */
export interface ActionItem {
  readonly order: number;
  readonly action: ActionDesc;
}

/** A view kind names a renderer and carries the view's state and message types. */
export interface ViewKind<S, M> {
  readonly id: string;
  readonly _state?: S;
  readonly _msg?: M;
}
export const defineViewKind = <S, M>(id: string): ViewKind<S, M> => ({ id });

/** What a published view is: which renderer, which stream to render, whose mailbox receives edits. */
export interface ViewRef {
  readonly kind: string;
  readonly stream: string;
  readonly inbox: string;
}

export const byOrder = <T extends { readonly order?: number }>(a: T, b: T): number =>
  (a.order ?? 0) - (b.order ?? 0);
