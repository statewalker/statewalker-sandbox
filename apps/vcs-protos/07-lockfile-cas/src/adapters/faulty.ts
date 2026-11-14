import type { AtomicFiles } from "../lockfile.js";

export type FaultPoint =
  | "createExclusive"
  | "after-createExclusive"
  | "replace"
  | "after-replace"
  | "remove";

/**
 * Wraps an AtomicFiles and simulates a process that dies at the chosen point: the call at that
 * point throws, and so does every call after it (a dead process runs no cleanup).
 */
export function faultyFiles(inner: AtomicFiles, at: FaultPoint): AtomicFiles {
  let dead = false;
  const check = (point: FaultPoint) => {
    if (dead || point === at) {
      dead = true;
      throw new Error(`injected crash at ${at}`);
    }
  };
  const alive = () => {
    if (dead) throw new Error(`injected crash at ${at}`);
  };
  return {
    read(p) {
      alive();
      return inner.read(p);
    },
    async exists(p) {
      alive();
      return inner.exists(p);
    },
    async remove(p) {
      check("remove");
      return inner.remove(p);
    },
    async createExclusive(p, c) {
      check("createExclusive");
      const r = await inner.createExclusive(p, c);
      check("after-createExclusive");
      return r;
    },
    async replace(s, t) {
      check("replace");
      await inner.replace(s, t);
      check("after-replace");
    },
  };
}
