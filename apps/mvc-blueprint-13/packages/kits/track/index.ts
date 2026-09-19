import type { KernelSlots, Listener, SlotDeclaration, Unsubscribe } from "@p5/kernel";
import { isReadable, type Read, signal, untracked } from "@p5/kit-signals";

/**
 * OPTIONAL kit (P4's fast path, K §4.3, D11): cross-bundle derivation over the model contract.
 * The substrate stays private to the kit; a getter made by the kit (`readable`) is read directly
 * — tracked and glitch-free kit-to-kit — anything else is bridged through its change channel
 * (tracked, but a listener that subscribed earlier can see the intermediate state).
 */
export function track<T>(
  get: () => T,
  on: (listener: Listener) => Unsubscribe,
): readonly [Read<T>, () => void] {
  if (isReadable(get)) return [get as Read<T>, () => {}];
  const value = signal(get());
  const off = on(() => value(get()));
  return [value, off];
}

/**
 * The first contribution of a one-contribution slot (shared state such as `contacts:selection`),
 * followed through `pick` as a tracked read: arrival, replacement and withdrawal (→ `undefined`)
 * included. Returns the read and its stop.
 */
export function trackFirst<M, T>(
  slots: Pick<KernelSlots, "observe">,
  decl: SlotDeclaration<M>,
  pick: (model: M) => readonly [get: () => T, on: (listener: Listener) => Unsubscribe],
): readonly [Read<T | undefined>, () => void] {
  const current = signal<{ read: Read<T> } | undefined>(undefined);
  let owner: M | undefined;
  let stop = () => {};
  const off = slots.observe(decl, (items) => {
    const next = items[0];
    if (next === owner) return;
    stop();
    stop = () => {};
    owner = next;
    if (next === undefined) {
      current(undefined);
      return;
    }
    const [read, s] = track(...pick(next));
    stop = s;
    current({ read });
  });
  return [
    () => current()?.read(),
    () => {
      off();
      stop();
      untracked(() => current(undefined));
    },
  ];
}
