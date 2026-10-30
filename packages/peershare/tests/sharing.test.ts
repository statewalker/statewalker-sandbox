/** M2 — the Sharer on its own mesh. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GetSharing, StartSharing, StopSharing } from "../src/public/commands.js";
import { meshFor, onMesh, startRelay } from "./mesh-harness.js";

let relay: Awaited<ReturnType<typeof startRelay>>;
beforeAll(async () => {
  relay = await startRelay();
});
afterAll(async () => {
  await relay?.stop();
});

describe("M2 — sharing", () => {
  it("start puts the Sharer on its mesh under a peer id that survives a reload; stop takes it off", async () => {
    const mesh = meshFor(relay.addr);
    const first = onMesh(mesh);

    const on = await first.call(StartSharing, undefined);
    expect(on).toMatchObject({ sharing: true, peerId: expect.stringMatching(/^12D3Koo/) });
    expect(await first.call(StopSharing, undefined)).toMatchObject({ sharing: false });
    first.dispose();

    const reloaded = onMesh(mesh);
    try {
      expect(await reloaded.call(StartSharing, undefined)).toEqual(on);
      expect(await reloaded.call(GetSharing, undefined)).toEqual(on);
    } finally {
      await reloaded.call(StopSharing, undefined);
      reloaded.dispose();
    }
  });
});
