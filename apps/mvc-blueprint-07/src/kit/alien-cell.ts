import { effect, setActiveSub, signal } from "alien-signals";
import { type Cell, shallowEqual } from "./cell.js";

/** A second substrate for the same contract (MODELS.md §5): alien-signals, kept private. */
export function alienCell<T>(initial: T, onError: (e: unknown) => void = console.error): Cell<T> {
  const value = signal(initial);
  let disposed = false;
  const stops = new Set<() => void>();
  const set = (next: T) => {
    if (disposed || shallowEqual(next, value())) return;
    value(next);
  };
  return {
    get: () => value(),
    subscribe(fn) {
      if (disposed) {
        try {
          fn();
        } catch (error) {
          onError(error);
        }
        return () => {};
      }
      let active = true;
      const outer = setActiveSub(undefined); // owned by no one, even if created inside an effect
      const stop = effect(() => {
        value();
        if (!active) return;
        const previous = setActiveSub(undefined); // the listener's own reads are not dependencies
        try {
          fn();
        } catch (error) {
          onError(error);
        } finally {
          setActiveSub(previous);
        }
      });
      setActiveSub(outer);
      const off = () => {
        if (!active) return;
        active = false;
        stops.delete(off);
        stop();
      };
      stops.add(off);
      return off;
    },
    set,
    patch: (p) => set({ ...value(), ...p }),
    dispose() {
      disposed = true;
      for (const off of [...stops]) off();
    },
  };
}
