/** M3–M5 — Dirk and Claudia: two runtimes, one real mesh. */

import { createServer } from "node:http";
import { createBridge, type Listening, listenLoopback } from "@statewalker/httpeers-share/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AddService,
  CloseSession,
  GetGuest,
  Invite,
  Join,
  ListGuests,
  ListSharedServices,
  Resume,
  RevokeGuest,
  SetName,
  StartSharing,
  StopSharing,
} from "../src/public/commands.js";
import {
  type GuestFetch,
  guestFetchSlot,
  type PeerShareModel,
  peershareModelSlot,
} from "../src/public/extension-points.js";
import type { MeshInit } from "../src/public/mesh.js";
import { meshFor, onMesh, startRelay } from "./mesh-harness.js";

const TOKEN = "peershare-m3";
let relay: Awaited<ReturnType<typeof startRelay>>;
let bridge: Listening;
let app: { origin: string; close(): Promise<void> };
let dirk: ReturnType<typeof onMesh>;
const others: { dispose(): void }[] = [];

beforeAll(async () => {
  relay = await startRelay();
  bridge = await listenLoopback(
    createBridge({ token: TOKEN, allowedOrigin: "https://tools.sandclaw.ai" }),
  );
  const server = createServer((req, res) => {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ app: "dirk", path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  app = {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };

  dirk = onMesh(meshFor(relay.addr), { bridge: () => ({ base: bridge.origin, token: TOKEN }) });
  await dirk.call(SetName, { name: "Dirk" });
  await dirk.call(AddService, { name: "fooService", kind: "bridged", target: app.origin });
  await dirk.call(StartSharing, undefined);
});
afterAll(async () => {
  for (const o of others) o.dispose();
  await dirk?.call(StopSharing, undefined);
  dirk?.dispose();
  await relay?.stop();
  await bridge?.close();
  await app?.close();
});

/** A Guest's browser: its own runtime and its own stores. */
function guest(mesh: MeshInit = meshFor(relay.addr)) {
  const g = onMesh(mesh);
  others.push(g);
  return g;
}

function guestFetchOf(g: ReturnType<typeof onMesh>): GuestFetch {
  let fetcher: GuestFetch | undefined;
  g.rt.slots.observe(guestFetchSlot, (v) => {
    fetcher = v[0];
  })();
  if (fetcher == null) throw new Error("no guest fetch");
  return fetcher;
}

describe("M3 — Invite and join", () => {
  it("Claudia joins with Dirk's link, sees his Services, and reaches his app through the mesh and the Bridge", async () => {
    const { url } = await dirk.call(Invite, undefined);
    const claudia = guest();

    expect(await claudia.call(Join, { link: url })).toMatchObject({
      stage: "joined",
      sharerName: "Dirk",
    });
    expect(await claudia.call(ListSharedServices, undefined)).toEqual([
      { id: "fooservice", name: "fooService", isDefault: true, paused: false },
    ]);
    const res = await guestFetchOf(claudia)("fooservice", new Request("http://service/hello?x=1"));
    expect(await res.json()).toEqual({ app: "dirk", path: "/hello?x=1" });
  });

  it("the same link a second time: invite-used", async () => {
    const { url } = await dirk.call(Invite, undefined);
    await guest().call(Join, { link: url });

    expect(await guest().call(Join, { link: url })).toMatchObject({ stage: "invite-used" });
    expect(await guest().call(GetGuest, undefined)).toMatchObject({ stage: "no-link" });
  });
});

describe("M5 — lifecycle", () => {
  it("Revoke: Claudia is in Dirk's guest list; after Revoke her next request is refused", async () => {
    const claudia = guest();
    const joined = await claudia.call(Join, { link: (await dirk.call(Invite, undefined)).url });
    expect(joined.stage).toBe("joined");
    const fetchFoo = () => guestFetchOf(claudia)("fooservice", new Request("http://service/"));
    expect((await fetchFoo()).status).toBe(200);

    const guests = await dirk.call(ListGuests, undefined);
    const peerId = guests.at(-1)?.peerId as string;
    await dirk.call(RevokeGuest, { peerId });

    expect([401, 403]).toContain((await fetchFoo()).status);
    expect((await dirk.call(ListGuests, undefined)).map((g) => g.peerId)).not.toContain(peerId);
  });

  it("closing the tab keeps her identity: a new runtime resumes without the Invite", async () => {
    const mesh = meshFor(relay.addr);
    const tab = guest(mesh);
    await tab.call(Join, { link: (await dirk.call(Invite, undefined)).url });
    tab.dispose();

    const again = guest(mesh);
    expect(await again.call(Resume, undefined)).toMatchObject({
      stage: "joined",
      sharerName: "Dirk",
    });
    expect(await again.call(ListSharedServices, undefined)).toHaveLength(1);
  });

  it("Close session forgets her: nothing to resume, and the link is spent", async () => {
    const mesh = meshFor(relay.addr);
    const tab = guest(mesh);
    const { url } = await dirk.call(Invite, undefined);
    await tab.call(Join, { link: url });

    expect(await tab.call(CloseSession, undefined)).toEqual({ stage: "no-link" });
    expect(await tab.call(Resume, undefined)).toEqual({ stage: "no-link" });
    expect(await tab.call(Join, { link: url })).toMatchObject({ stage: "invite-used" });
  });
});

describe("M5 — Dirk stops, and comes back after a reload", () => {
  it("Claudia sees machine-offline, then is back in with no new Invite", async () => {
    const dirkMesh = meshFor(relay.addr);
    const pairing = () => ({ base: bridge.origin, token: TOKEN });
    const store = (await import("./harness.js")).memoryStore();
    const before = onMesh(dirkMesh, { store, bridge: pairing });
    await before.call(SetName, { name: "Dirk" });
    await before.call(AddService, { name: "app", kind: "bridged", target: app.origin });
    await before.call(StartSharing, undefined);
    const claudia = guest();
    await claudia.call(Join, { link: (await before.call(Invite, undefined)).url });
    const fetchApp = () => guestFetchOf(claudia)("app", new Request("http://service/"));

    await before.call(StopSharing, undefined);
    before.dispose();
    await fetchApp();
    expect(await claudia.call(GetGuest, undefined)).toMatchObject({ stage: "machine-offline" });

    const after = onMesh(dirkMesh, { store, bridge: pairing });
    others.push({ dispose: () => void after.call(StopSharing, undefined) });
    await after.call(StartSharing, undefined);
    let status = 0;
    for (let i = 0; i < 100 && status !== 200; i++) {
      status = (await fetchApp()).status;
      if (status !== 200) await new Promise((r) => setTimeout(r, 200));
    }
    expect(status).toBe(200);
    expect(await claudia.call(GetGuest, undefined)).toMatchObject({ stage: "joined" });
  });
});

describe("M5 — Dirk sees who joined", () => {
  it("a Guest who joins appears in Dirk's model, without Dirk asking", async () => {
    let model: PeerShareModel | undefined;
    dirk.rt.slots.observe(peershareModelSlot, (v) => {
      model = v[0];
    })();
    const before = model?.getSnapshot().guests.length ?? 0;

    await guest().call(Join, { link: (await dirk.call(Invite, undefined)).url });

    await expect
      .poll(() => model?.getSnapshot().guests.length, { timeout: 5_000 })
      .toBe(before + 1);
    const joinedAt = model?.getSnapshot().guests.at(-1)?.joinedAt ?? 0;
    expect(Math.abs(Date.now() - joinedAt)).toBeLessThan(60_000);
  });
});
