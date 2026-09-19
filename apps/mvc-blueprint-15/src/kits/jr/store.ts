import type { StateStore } from "@json-render/core";
import type { ActionContribution, ActionState, ActionView, Listener, Unsubscribe } from "@kernel";

/** One model group: its getter and its change channel (the model contract, MODELS §4). */
export type Group<T = unknown> = readonly [read: () => T, subscribe: (l: Listener) => Unsubscribe];

/** An action list as the spec sees it: `ids` to `repeat` over, `states` to look each one up. */
export interface ActionList {
  /** One `{ id }` per action, each identity-stable while listed; the array too while unchanged. */
  readonly ids: readonly { readonly id: string }[];
  readonly states: Readonly<Record<string, ActionState>>;
}

/**
 * How one view model appears to a spec. The ONLY place a spec meets a model:
 * - `values`: top-level state keys, one model group each — read-only;
 * - `actions`: `ActionView`s, readable as `/<key>` (their `ActionState`), raised by `submit {ref: key}`;
 * - `actionLists`: contributed actions, readable as `/<key>` (an `ActionList`: `ids` to repeat
 *   over, `states` by id), raised by `submit {ref: "<key>/<id>"}`. Ids and states are apart because
 *   `@json-render/solid` ignores `repeat.key` and keys rows by item identity: an item carrying its
 *   state would be re-created (and lose focus) whenever that action's state changed. They are ONE
 *   group, so a listener never sees ids and states from two different moments;
 * - `writes`: the writable JSON Pointers, each turned into the model's intent mutator;
 * - `intents`: named intents a spec may invoke (`on: { press: { action: "<name>", params } }`).
 * Every other write path is refused.
 */
export interface ModelBinding {
  readonly values?: Readonly<Record<string, Group>>;
  readonly actions?: Readonly<Record<string, ActionView>>;
  readonly actionLists?: Readonly<Record<string, Group<readonly ActionContribution[]>>>;
  readonly writes?: Readonly<Record<string, (value: unknown) => void>>;
  readonly intents?: Readonly<Record<string, (params: Record<string, unknown>) => void>>;
}

/** Group helper for a model group whose value never changes (e.g. `ConfirmView.getQuestion`). */
export const constant = <T>(value: T): Group<T> => [() => value, () => () => {}];

/** An `ActionContribution[]` group as one `ActionList` group (see `ModelBinding.actionLists`). */
function actionList([read, subscribe]: Group<readonly ActionContribution[]>): Group<ActionList> {
  const byId = new Map<string, { readonly id: string }>();
  let last: ActionList = { ids: [], states: {} };
  const get = () => {
    const list = read();
    const ids = list.map(
      (c) => byId.get(c.id) ?? (byId.set(c.id, { id: c.id }).get(c.id) as never),
    );
    const states = Object.fromEntries(list.map((c) => [c.id, c.action.getState()]));
    const sameIds = ids.length === last.ids.length && ids.every((e, i) => e === last.ids[i]);
    const keys = Object.keys(states);
    const sameStates =
      keys.length === Object.keys(last.states).length &&
      keys.every((k) => last.states[k] === states[k]);
    if (!sameIds || !sameStates)
      last = { ids: sameIds ? last.ids : ids, states: sameStates ? last.states : states };
    return last;
  };
  const on = (listener: Listener) => {
    let inner: Unsubscribe[] = [];
    const drop = () => {
      for (const u of inner) u();
      inner = [];
    };
    const outer = subscribe(() => {
      drop();
      inner = read().map((c) => c.action.onStateUpdate(listener));
      listener();
    });
    return () => {
      outer();
      drop();
    };
  };
  return [get, on];
}

export interface ModelStore {
  /** The controlled json-render store: pass it as `store={…}` to the technology's provider. */
  readonly state: StateStore;
  /** The action handlers: pass them as `handlers={…}`. `submit` plus the binding's intents. */
  readonly handlers: Readonly<Record<string, (params: Record<string, unknown>) => void>>;
}

/**
 * THE adapter: a view model as a json-render `StateStore`, and the single write path into it.
 *
 * - The snapshot is `{ [key]: group value }`, rebuilt only for the key whose group changed, and only
 *   when its value's identity changed (contract point 7). A notification that changed nothing
 *   reaches no store listener: zero renderer work for a no-op (the binding probe measures it).
 * - One model subscription per group, taken when the first store listener arrives and released
 *   with the last one.
 * - `set(path)` / `update({path…})` reach the model only through `binding.writes[path]`. Any other
 *   path — a presentation group, an action state, `setState`/`pushState` emitted by a spec — is
 *   refused: `refuse(message)` is called and nothing is written (an `update` is refused whole).
 */
export function modelStore(binding: ModelBinding, refuse: (message: string) => void): ModelStore {
  const groups: Record<string, Group> = { ...binding.values };
  for (const [key, action] of Object.entries(binding.actions ?? {}))
    groups[key] = [action.getState, action.onStateUpdate];
  for (const [key, list] of Object.entries(binding.actionLists ?? {}))
    groups[key] = actionList(list);
  const keys = Object.keys(groups);
  const writes = binding.writes ?? {};

  let snapshot: Readonly<Record<string, unknown>> = Object.freeze(
    Object.fromEntries(keys.map((k) => [k, (groups[k] as Group)[0]()])),
  );
  const listeners = new Set<Listener>();
  let unsubscribe: Unsubscribe[] | undefined;

  const refresh = (key: string) => {
    const value = (groups[key] as Group)[0]();
    if (snapshot[key] === value) return;
    snapshot = Object.freeze({ ...snapshot, [key]: value });
    for (const l of [...listeners]) l();
  };
  const current = () => {
    if (!unsubscribe) for (const k of keys) refresh(k);
    return snapshot;
  };
  const refused = (path: string) => {
    refuse(`jr: refused write to "${path}" — not a form field of this view`);
  };

  const state: StateStore = {
    get: (path) => {
      let v: unknown = current();
      for (const seg of path.split("/").slice(1))
        v = (v as Record<string, unknown> | undefined)?.[seg];
      return v;
    },
    set(path, value) {
      const write = writes[path];
      if (write) write(value);
      else refused(path);
    },
    update(updates) {
      const paths = Object.keys(updates);
      const bad = paths.filter((p) => !writes[p]);
      if (bad.length > 0) return refused(bad.join(", "));
      for (const p of paths) (writes[p] as (v: unknown) => void)(updates[p]);
    },
    getSnapshot: current,
    subscribe(listener) {
      if (!unsubscribe) current(); // before the listener is added: it must not see this refresh
      listeners.add(listener);
      if (!unsubscribe) {
        // Mark subscribed BEFORE subscribing: a group calls back immediately (contract point 1),
        // and a listener reading the snapshot then must get the cached one, not re-refresh (with
        // a model breaking point 7 that re-refresh recursed until the stack overflowed).
        const offs: Unsubscribe[] = [];
        unsubscribe = offs;
        for (const k of keys) offs.push((groups[k] as Group)[1](() => refresh(k)));
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0 || !unsubscribe) return;
        for (const u of unsubscribe) u();
        unsubscribe = undefined;
      };
    },
  };

  const submit = ({ ref }: Record<string, unknown>) => {
    const [key, id] = String(ref).split("/");
    const action =
      id === undefined
        ? binding.actions?.[key as string]
        : binding.actionLists?.[key as string]?.[0]().find((c) => c.id === id)?.action;
    if (action) action.submit();
    else refuse(`jr: no action "${String(ref)}" in this view`);
  };
  return { state, handlers: { ...binding.intents, submit } };
}
