/** M6 — views follow PeerShare through one external store, not by polling commands. */

import { describe, expect, it } from "vitest";
import { AddService, SetName, ToggleService } from "../src/public/commands.js";
import { type PeerShareModel, peershareModelSlot } from "../src/public/extension-points.js";
import { withPeerShare } from "./harness.js";

function modelOf(rt: ReturnType<typeof withPeerShare>["rt"]): PeerShareModel {
  let model: PeerShareModel | undefined;
  rt.slots.observe(peershareModelSlot, (v) => {
    model = v[0];
  })();
  if (model == null) throw new Error("no model");
  return model;
}

describe("M6 — the model", () => {
  it("every change notifies subscribers, and the snapshot is new each time (useSyncExternalStore)", async () => {
    const { rt, call } = withPeerShare();
    const model = modelOf(rt);
    const seen: unknown[] = [];
    model.subscribe(() => seen.push(model.getSnapshot()));
    const first = model.getSnapshot();

    await call(SetName, { name: "Dirk" });
    await call(AddService, { name: "foo", kind: "bridged", target: "http://localhost:5173" });
    await call(ToggleService, { id: "foo", enabled: false });

    expect(seen.length).toBeGreaterThanOrEqual(3);
    const last = model.getSnapshot();
    expect(last).not.toBe(first);
    expect(model.getSnapshot()).toBe(last); // stable between changes
    expect(last.sharer).toMatchObject({ name: "Dirk", services: [{ id: "foo", enabled: false }] });
    expect(last.sharing).toEqual({ sharing: false });
    expect(last.guest).toEqual({ stage: "no-link" });
  });
});
