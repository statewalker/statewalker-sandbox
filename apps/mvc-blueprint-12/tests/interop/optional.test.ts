import { type Listener, readable, signal, track } from "@kernel";
import { createAction } from "@kit/model";
import { describe, expect, it } from "vitest";

/**
 * Point to clarify 2 — could the substrate be OPTIONAL without two contracts? Keep P0's contract
 * (`getSelected` / `onSelectedUpdate`) at the boundary; an owner opts in by making `getSelected` a
 * kernel `Readable` (and `onSelectedUpdate` its `.subscribe`). A consumer uses `track(get, on)`:
 * direct tracked read when the owner opted in, a bridge otherwise. Measured: does an EARLY
 * observer of the owner see the consumer's derived `enabled` stale?
 */
interface SelectionFacet {
  getSelected(): string | undefined;
  onSelectedUpdate(listener: Listener): () => void;
}

function substrateOwner() {
  const selected = signal<string | undefined>(undefined);
  const r = readable(selected);
  const facet: SelectionFacet = { getSelected: r, onSelectedUpdate: r.subscribe };
  return { facet, select: (id: string | undefined) => selected(id) };
}

function plainOwner() {
  let selected: string | undefined;
  const listeners = new Set<Listener>();
  const facet: SelectionFacet = {
    getSelected: () => selected,
    onSelectedUpdate(l) {
      listeners.add(l);
      l();
      return () => void listeners.delete(l);
    },
  };
  return {
    facet,
    select(id: string | undefined) {
      selected = id;
      for (const l of [...listeners]) l();
    },
  };
}

function measure(owner: ReturnType<typeof substrateOwner> | ReturnType<typeof plainOwner>) {
  const glitches: string[] = [];
  let action: ReturnType<typeof createAction> | undefined;
  // The early observer subscribes to the owner BEFORE the consumer exists.
  owner.facet.onSelectedUpdate(() => {
    if (!action) return;
    const has = owner.facet.getSelected() !== undefined;
    const enabled = action.view.getState().enabled;
    if (enabled !== has) glitches.push(`selected=${has} enabled=${enabled}`);
  });
  // The consumer (another bundle): enabled derived from the owner's facet, P0's contract shape.
  const followed = track(owner.facet.getSelected, owner.facet.onSelectedUpdate);
  action = createAction({ label: "Link", when: () => followed.read() !== undefined });
  for (const id of ["a", undefined, "b", undefined]) owner.select(id);
  followed.stop();
  return glitches;
}

describe("optional substrate, one contract (getX/onXUpdate)", () => {
  it("owner opted in (its getter is a kernel Readable): no glitch", () => {
    expect(measure(substrateOwner())).toEqual([]);
  });
  it("owner on plain listeners: bridged, correct afterwards, but the early observer sees it stale", () => {
    const glitches = measure(plainOwner());
    expect(glitches).toHaveLength(4);
  });
});
