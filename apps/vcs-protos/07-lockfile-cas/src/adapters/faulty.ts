import type { AtomicFiles } from "../lockfile.js";

export type FaultPoint =
  | "createExclusive"
  | "after-createExclusive"
  | "replace"
  | "after-replace"
  | "remove";

/** Wraps an AtomicFiles and throws at the chosen point once (a simulated crash). */
export function faultyFiles(inner: AtomicFiles, at: FaultPoint): AtomicFiles {
  let fired = false;
  const crash = (point: FaultPoint) => {
    if (!fired && point === at) {
      fired = true;
      throw new Error(`injected crash at ${point}`);
    }
  };
  return {
    read: (p) => inner.read(p),
    exists: (p) => inner.exists(p),
    async remove(p) {
      crash("remove");
      return inner.remove(p);
    },
    async createExclusive(p, c) {
      crash("createExclusive");
      const r = await inner.createExclusive(p, c);
      crash("after-createExclusive");
      return r;
    },
    async replace(s, t) {
      crash("replace");
      await inner.replace(s, t);
      crash("after-replace");
    },
  };
}
