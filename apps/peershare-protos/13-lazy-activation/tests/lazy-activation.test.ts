/**
 * 13 — Can SandClaw list PeerShare without importing it?
 */

import { describe, expect, it } from "vitest";
import { AddService, ListServices } from "../../12-feature-contribution/src/commands.js";
import {
  type AppMenuItem,
  createRuntime,
  menuItemsSlot,
} from "../../12-feature-contribution/src/suite.js";
import { lazyFeature } from "../src/lazy-feature.js";
import { PEERSHARE_MANIFEST } from "../src/manifest.js";

const evaluated = () => (globalThis as { __peershareEvaluated?: number }).__peershareEvaluated ?? 0;

function menu(rt: ReturnType<typeof createRuntime>): readonly AppMenuItem[] {
  let items: readonly AppMenuItem[] = [];
  rt.slots.observe(menuItemsSlot, (v) => {
    items = v;
  })();
  return items;
}

describe("13 — lazy activation", () => {
  it("the menu renders from the manifest, and PeerShare's code has not run", () => {
    const before = evaluated();
    const rt = createRuntime();
    lazyFeature(PEERSHARE_MANIFEST, async () =>
      (await import("../src/heavy.js")).peershareFeature(),
    ).contribute(rt);

    expect(menu(rt).map((i) => i.label)).toEqual(["Share a local service"]);
    expect(evaluated()).toBe(before);
  });

  it("the first PeerShare command imports it once, and is answered by the real Feature", async () => {
    const rt = createRuntime();
    let loads = 0;
    lazyFeature(PEERSHARE_MANIFEST, async () => {
      loads++;
      return (await import("../src/heavy.js")).peershareFeature();
    }).contribute(rt);

    const added = await rt.commands.call(AddService, {
      name: "foo",
      kind: "bridged",
      target: "http://localhost:5173",
    }).promise;
    expect(added).toMatchObject({ ok: true });
    expect(evaluated()).toBeGreaterThan(0);

    expect(await rt.commands.call(ListServices, undefined).promise).toHaveLength(1);
    expect(loads).toBe(1);
  });

  it("the manifest cannot drift: after activation, the real menu and commands are exactly the manifest's", async () => {
    const rt = createRuntime();
    lazyFeature(PEERSHARE_MANIFEST, async () =>
      (await import("../src/heavy.js")).peershareFeature(),
    ).contribute(rt);
    const before = menu(rt);

    await rt.commands.call(ListServices, undefined).promise;

    expect(menu(rt)).toEqual(before);
    expect(
      rt.handled
        .list()
        .map((d) => d.key)
        .sort(),
    ).toEqual(PEERSHARE_MANIFEST.commands.map((d) => d.key).sort());
  });
});
