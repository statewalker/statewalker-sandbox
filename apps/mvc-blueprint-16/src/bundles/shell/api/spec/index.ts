import { type ActionView, defineKeyedSlot, type ViewKind } from "@kernel";

/**
 * The view-spec API (J3): a technology-neutral renderer extension point. A spec is plain JSON data
 * that describes one view kind's markup and binds it to the kind's view model **by name**: a read
 * names a model group (`getX` / `onXUpdate`), a write names an intent (a mutator of the view
 * facet) or an action (`ActionView.submit`). There is no path write and no generic setter in the
 * grammar. Each UI technology contributes one interpreter that turns specs into its renderers.
 * Declarations only.
 */

// ── names, checked against the view model's type ────────────────────────────────────────────
/** `getItems` → `"items"`: the groups a spec may read. An unknown model (the interpreters) accepts any name. */
export type GroupName<M> = unknown extends M
  ? string
  : {
      [K in keyof M]: K extends `get${infer G}` ? Uncapitalize<G> : never;
    }[keyof M] &
      string;
/** A group, or a field inside it: `"draft"`, `"draft.title"`. */
export type ReadPath<M> = GroupName<M> | `${GroupName<M>}.${string}`;
/** The view facet's mutators: functions that are neither readers nor subscribers. */
export type IntentName<M> = unknown extends M
  ? string
  : {
      // biome-ignore lint/suspicious/noExplicitAny: any function shape
      [K in keyof M]: M[K] extends (...args: any[]) => any
        ? K extends `get${string}` | `on${string}Update`
          ? never
          : K
        : never;
    }[keyof M] &
      string;
/** Members that are actions. */
export type ActionName<M> = unknown extends M
  ? string
  : {
      [K in keyof M]: M[K] extends ActionView ? K : never;
    }[keyof M] &
      string;

// ── expressions: pure, evaluated against groups, the `each` item and the triggering event ───
export type Expr<M = unknown> =
  | string
  | number
  | boolean
  | null
  | readonly Expr<M>[]
  | { readonly read: ReadPath<M> }
  /** The current `each` item, or a field of it (`"id"`, `"title"`); `"."` is the item itself. */
  | { readonly item: string }
  /** What the triggering DOM event carries: an input's value or checked, a Ctrl/Meta modifier. */
  | { readonly event: "value" | "checked" | "extend" }
  | { readonly concat: readonly Expr<M>[] }
  | { readonly eq: readonly [Expr<M>, Expr<M>] }
  | { readonly includes: readonly [Expr<M>, Expr<M>] }
  /** A list with the value removed if present, appended if absent. */
  | { readonly toggle: readonly [Expr<M>, Expr<M>] }
  /** `[condition, then, else?]`; a missing else is `null`. */
  | { readonly if: readonly [Expr<M>, Expr<M>] | readonly [Expr<M>, Expr<M>, Expr<M>] };

// ── writes: the only two ─────────────────────────────────────────────────────────────────────
export type Handler<M = unknown> =
  | { readonly intent: IntentName<M>; readonly args?: readonly Expr<M>[] }
  | { readonly submit: ActionName<M> };
export type EventName = "click" | "input" | "change" | "submit";

// ── nodes ────────────────────────────────────────────────────────────────────────────────────
export type Tag = "div" | "p" | "span" | "ul" | "li" | "form" | "input" | "dl" | "dt" | "dd";
export interface ElementNode<M = unknown> {
  readonly el: Tag;
  /** `value` and `checked` are controlled: after a handler runs, they are reset to the model's. */
  readonly attrs?: Readonly<Record<string, Expr<M>>>;
  /** Handlers run in order, in the same tick; `submit` events never navigate. */
  readonly on?: Readonly<Partial<Record<EventName, Handler<M> | readonly Handler<M>[]>>>;
  readonly children?: readonly SpecNode<M>[];
}
export type SpecNode<M = unknown> =
  /** Static text. */
  | string
  | { readonly text: Expr<M> }
  | ElementNode<M>
  /** Children once per item of a list; inside, `{ item }` reads it. */
  | { readonly each: Expr<M>; readonly children: readonly SpecNode<M>[] }
  /** Children while the condition is truthy. */
  | { readonly when: Expr<M>; readonly children: readonly SpecNode<M>[] }
  /** One action of the model as a button (label, enabled, running from the action's state). */
  | { readonly action: ActionName<M> }
  /** A group holding `ActionContribution[]` as a toolbar. */
  | { readonly actions: GroupName<M>; readonly label: string };

export interface ViewSpec<M = unknown> {
  readonly root: SpecNode<M>;
}

// ── the extension point ──────────────────────────────────────────────────────────────────────
export interface SpecContribution<M = unknown> {
  readonly kind: ViewKind<M>;
  readonly spec: ViewSpec<M>;
}
/** What the slot holds: any kind, with its spec widened to plain names. */
export interface AnySpecContribution {
  readonly kind: ViewKind<never>;
  readonly spec: ViewSpec;
}
/** Keyed by kind id. Contributed by `*.ui.spec` bundles; read by each technology's interpreter. */
export const viewSpecsSlot = defineKeyedSlot<AnySpecContribution>("ui:specs");
