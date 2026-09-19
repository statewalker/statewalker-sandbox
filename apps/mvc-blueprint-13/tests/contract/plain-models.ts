import type { ActionState, ActionView, Listener } from "@p5/kernel";

/**
 * Hand-rolled second implementations of the three model kinds: a listener set, no library.
 * They exist so the contract suite describes the contract, not the kit's substrate.
 */
function group<T>(initial: T, equal: (a: T, b: T) => boolean = Object.is) {
  let value = initial;
  let live = true;
  const listeners = new Set<Listener>();
  const call = (l: Listener) => {
    try {
      l();
    } catch (error) {
      console.error(error);
    }
  };
  return {
    get: () => value,
    on(listener: Listener) {
      if (!live) return () => {};
      const entry = () => listener();
      listeners.add(entry);
      call(entry);
      return () => void listeners.delete(entry);
    },
    set(next: T) {
      if (!live || equal(value, next)) return;
      value = next;
      for (const l of [...listeners]) if (listeners.has(l)) call(l);
    },
    dispose() {
      live = false;
      listeners.clear();
    },
  };
}

const shallow = <T extends object>(a: T, b: T) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((k) => Object.is(a[k as keyof T], b[k as keyof T]));

/** Presentation: the controller publishes; the view reads. */
export function plainPresentation<T extends object>(initial: T) {
  const g = group(Object.freeze(initial), shallow);
  return {
    view: Object.freeze({ get: g.get, on: g.on }),
    control: Object.freeze({ publish: (v: T) => g.set(Object.freeze({ ...v })) }),
    dispose: g.dispose,
  };
}

/** Form: the view edits field by field; the controller resets the whole draft. */
export function plainForm<T extends Record<string, unknown>>(base: T) {
  const draft = group(Object.freeze({ ...base }), shallow);
  const errors = group<Readonly<Record<string, string>>>(Object.freeze({}), shallow);
  return {
    view: Object.freeze({
      getDraft: draft.get,
      onDraftUpdate: draft.on,
      getErrors: errors.get,
      onErrorsUpdate: errors.on,
      editField: <K extends keyof T>(field: K, value: T[K]) =>
        draft.set(Object.freeze({ ...draft.get(), [field]: value })),
    }),
    control: Object.freeze({
      reset: (next: T) => draft.set(Object.freeze({ ...next })),
      reportErrors: (e: Record<string, string>) => errors.set(Object.freeze({ ...e })),
    }),
    dispose: () => {
      draft.dispose();
      errors.dispose();
    },
  };
}

/** Action: the view submits; the controller describes. `update` is a patch (undefined = leave). */
export function plainAction(label: string): {
  view: ActionView;
  control: {
    getSubmits(): number;
    onSubmitsUpdate(listener: Listener): () => void;
    update(patch: Partial<Omit<ActionState, "running">>): void;
  };
  dispose(): void;
} {
  const state = group<ActionState>(
    Object.freeze({ label, enabled: true, running: false }),
    shallow,
  );
  const submits = group(0);
  let live = true;
  return {
    view: Object.freeze({
      getState: state.get,
      onStateUpdate: state.on,
      submit: () => {
        const s = state.get();
        if (live && s.enabled && !s.running) submits.set(submits.get() + 1);
      },
    }),
    control: Object.freeze({
      getSubmits: submits.get,
      onSubmitsUpdate: submits.on,
      update: (patch: Partial<Omit<ActionState, "running">>) => {
        const defined = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        state.set(Object.freeze({ ...state.get(), ...defined }));
      },
    }),
    dispose: () => {
      live = false;
      state.dispose();
      submits.dispose();
    },
  };
}
