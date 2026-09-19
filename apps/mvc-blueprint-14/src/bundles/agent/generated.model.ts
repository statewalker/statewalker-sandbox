import type { GeneratedState, GeneratedStatus, GeneratedView } from "@b/agent/api";
import type { Spec, StateStore } from "@json-render/core";
import type { ActionView } from "@kernel";
import { type CommitActionModel, createCommitAction } from "@kit/commit";
import { newChannels, shallowEqual, stableGroup } from "@kit/model";
import { batch, signal, untracked } from "@kit/signals";

/** The controller's side of a generated view. The only writer of the presentation groups. */
export interface GeneratedControl {
  publishSpec(spec: Spec | null): void;
  publishStatus(status: GeneratedStatus): void;
  /** Adds form fields the spec seeds; never overwrites a field that exists (the view owns it). */
  seed(values: Readonly<Record<string, unknown>>): void;
  publishData(data: Readonly<Record<string, unknown>>): void;
  publishActions(actions: Readonly<Record<string, ActionView>>): void;
  publishOutcome(outcome: string | undefined): void;
}

export interface GeneratedModel {
  readonly view: GeneratedView;
  readonly control: GeneratedControl;
  /** The composite json-render reads; also what an action's capture resolves params against. */
  readonly state: () => GeneratedState;
  readonly close: CommitActionModel<null>;
  dispose(): void;
}

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});
const NO_ACTIONS: Readonly<Record<string, ActionView>> = Object.freeze({});
const STREAMING: GeneratedStatus = Object.freeze({ phase: "streaming", issues: Object.freeze([]) });

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** RFC 6901 pointer → tokens. */
const tokens = (path: string) =>
  path
    .split("/")
    .slice(1)
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));

/**
 * A generated view's model. `onRefused(path)` is told about every write json-render attempts
 * outside the form group — the controller logs it; nothing is written.
 */
export function createGeneratedModel(onRefused: (path: string) => void): GeneratedModel {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const spec = signal<Spec | null>(null);
  const status = signal<GeneratedStatus>(STREAMING);
  const values = signal<Readonly<Record<string, unknown>>>(EMPTY);
  const data = signal<Readonly<Record<string, unknown>>>(EMPTY);
  const actions = signal<Readonly<Record<string, ActionView>>>(NO_ACTIONS);
  const outcome = signal<string | undefined>(undefined);
  const close = createCommitAction<null>({ label: "Close", capture: () => null });

  const state = stableGroup((): GeneratedState => Object.freeze({ form: values(), data: data() }));

  const editField = (field: string, value: unknown) => {
    if (disposed) return;
    const current = untracked(() => values());
    if (!Object.hasOwn(current, field)) {
      onRefused(`/form/${field}`);
      return;
    }
    if (Object.is(current[field], value)) return;
    values(Object.freeze({ ...current, [field]: deepFreeze(structuredClone(value)) }));
  };

  /** The one path a generated UI may write: `/form/<declared field>`. */
  const write = (path: string, value: unknown) => {
    const t = tokens(path);
    if (t.length === 2 && t[0] === "form") editField(t[1] as string, value);
    else onRefused(path);
  };

  const store: StateStore = Object.freeze({
    get: (path: string) => {
      let node: unknown = untracked(state);
      for (const t of tokens(path)) {
        if (typeof node !== "object" || node === null) return undefined;
        node = (node as Record<string, unknown>)[t];
      }
      return node;
    },
    set: (path: string, value: unknown) => write(path, value),
    update: (updates: Record<string, unknown>) =>
      batch(() => {
        for (const [path, value] of Object.entries(updates)) write(path, value);
      }),
    getSnapshot: () => untracked(state) as unknown as Record<string, unknown>,
    subscribe: channels.channel(state),
  });

  const view: GeneratedView = Object.freeze({
    getSpec: () => spec(),
    onSpecUpdate: channels.channel(spec),
    getStatus: () => status(),
    onStatusUpdate: channels.channel(status),
    getValues: () => values(),
    onValuesUpdate: channels.channel(values),
    editField,
    getData: () => data(),
    onDataUpdate: channels.channel(data),
    getActions: () => actions(),
    onActionsUpdate: channels.channel(actions),
    getOutcome: () => outcome(),
    onOutcomeUpdate: channels.channel(outcome),
    close: close.view,
    store,
  });

  const control: GeneratedControl = Object.freeze({
    publishSpec: (next: Spec | null) => {
      if (!disposed && untracked(() => spec()) !== next)
        spec(next === null ? null : deepFreeze(next));
    },
    publishStatus: (next: GeneratedStatus) => {
      if (
        !disposed &&
        !shallowEqual(
          untracked(() => status()),
          next,
        )
      )
        status(deepFreeze(next));
    },
    seed: (next: Readonly<Record<string, unknown>>) => {
      if (disposed) return;
      const current = untracked(() => values());
      const added = Object.keys(next).filter((k) => !Object.hasOwn(current, k));
      if (added.length === 0) return;
      const merged: Record<string, unknown> = { ...current };
      for (const k of added) merged[k] = deepFreeze(structuredClone(next[k]));
      values(Object.freeze(merged));
    },
    publishData: (next: Readonly<Record<string, unknown>>) => {
      if (
        !disposed &&
        !shallowEqual(
          untracked(() => data()),
          next,
        )
      )
        data(deepFreeze({ ...next }));
    },
    publishActions: (next: Readonly<Record<string, ActionView>>) => {
      if (
        !disposed &&
        !shallowEqual(
          untracked(() => actions()),
          next,
        )
      )
        actions(Object.freeze({ ...next }));
    },
    publishOutcome: (next: string | undefined) => {
      if (!disposed && untracked(() => outcome()) !== next) outcome(next);
    },
  });

  return Object.freeze({
    view,
    control,
    state: () => untracked(state),
    close,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      close.dispose();
      channels.dispose();
    },
  });
}
