import type { StateStore } from "@json-render/core";
import type { ActionContribution, ActionState, ActionView, Listener, Unsubscribe } from "@kernel";

/** One model group: its getter and its change channel (the model contract, MODELS §4). */
export type Group<T = unknown> = readonly [read: () => T, subscribe: (l: Listener) => Unsubscribe];

/** An action offered in a list, as the spec sees it: `{ id }`, identity-stable while listed. */
export interface ActionEntry {
  readonly id: string;
}

/**
 * How one view model appears to a spec. The ONLY place a spec meets a model:
 * - `values`: top-level state keys, one model group each — read-only;
 * - `actions`: `ActionView`s, readable as `/<key>` (their `ActionState`), raised by `submit {ref: key}`;
 * - `actionLists`: contributed actions: `/<key>` is the list (`ActionEntry[]`, one `{ id }` per
 *   action, to `repeat` over), `/<key>State` maps each id to its `ActionState`; raised by
 *   `submit {ref: "<key>/<id>"}`. Split in two because `@json-render/solid` ignores `repeat.key`
 *   and keys rows by item identity: an entry that carried its state would be re-created (and lose
 *   focus) whenever that action's state changed;
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

/** Keeps the previous array when every element is the same (contract point 7 for derived lists). */
function stable<T>(read: () => readonly T[]): () => readonly T[] {
  let last: readonly T[] = [];
  return () => {
    const next = read();
    if (next.length !== last.length || next.some((e, i) => e !== last[i])) last = next;
    return last;
  };
}

/** An `ActionContribution[]` group as `[ids, states]` groups (see `ModelBinding.actionLists`). */
function actionList([read, subscribe]: Group<readonly ActionContribution[]>): [Group, Group] {
  const byId = new Map<string, ActionEntry>();
  const ids = stable(() =>
    read().map((c) => byId.get(c.id) ?? (byId.set(c.id, { id: c.id }).get(c.id) as ActionEntry)),
  );
  let lastStates: Record<string, ActionState> = {};
  const states = () => {
    const next = Object.fromEntries(read().map((c) => [c.id, c.action.getState()]));
    const keys = Object.keys(next);
    const same =
      keys.length === Object.keys(lastStates).length &&
      keys.every((k) => lastStates[k] === next[k]);
    if (!same) lastStates = next;
    return lastStates;
  };
  const onStates = (listener: Listener) => {
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
  return [
    [ids, subscribe],
    [states, onStates],
  ];
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
  for (const [key, list] of Object.entries(binding.actionLists ?? {})) {
    // States first: both keys follow the same list, and a listener sees the ids refreshed only
    // after the states they index — otherwise a new row resolves `at(states, id)` to undefined.
    const [ids, states] = actionList(list);
    groups[`${key}State`] = states;
    groups[key] = ids;
  }
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
      listeners.add(listener);
      if (!unsubscribe) {
        current();
        unsubscribe = keys.map((k) => (groups[k] as Group)[1](() => refresh(k)));
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
