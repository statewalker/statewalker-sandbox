/**
 * Shared view-data types — what the kernel's "model module" shrinks to in R1.
 * A view receives plain, frozen data derived from state, plus `dispatch`. Nothing here notifies.
 */
import type { Msg } from "./store.ts";

/** A view kind carries its props type so renderers are typed. */
export interface ViewKind<P> {
  readonly id: string;
  readonly _props?: P;
}
export const defineViewKind = <P>(id: string): ViewKind<P> => ({ id });

/**
 * What P0 calls an action model, as data: the view dispatches `msg`; the owning update decides
 * what it means (and reads the state it acts on at that moment).
 */
export interface ActionItem {
  readonly id: string;
  readonly order: number;
  readonly label: string;
  readonly enabled: boolean;
  readonly running?: boolean;
  readonly msg: Msg;
}

export type Dispatch = (msg: Msg) => void;
