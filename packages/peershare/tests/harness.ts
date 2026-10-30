/** A headless suite runtime with PeerShare in it: the seam every logic test drives. */

import { type PeerShareInit, peershare } from "../src/public/feature.js";
import { createRuntime } from "../src/public/suite.js";
import type { SharerState, SharerStore } from "../src/public/types.js";

export function memoryStore(initial?: SharerState): SharerStore & { saved: SharerState[] } {
  const saved: SharerState[] = initial == null ? [] : [initial];
  return {
    saved,
    load: async () => structuredClone(saved.at(-1)),
    save: async (state) => {
      saved.push(structuredClone(state));
    },
  };
}

export function withPeerShare(init: Partial<PeerShareInit> = {}) {
  const rt = createRuntime();
  const store = init.store ?? memoryStore();
  const dispose = peershare({ store, ...init }).contribute(rt);
  const call = <P, R>(
    decl: import("@statewalker/shared-commands").CommandDeclaration<P, R>,
    payload: P,
  ) => rt.commands.call(decl, payload).promise;
  return { rt, store, call, dispose };
}
