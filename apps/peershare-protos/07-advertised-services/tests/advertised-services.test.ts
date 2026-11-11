/**
 * 07 — Does a Guest see the list, the Default Service and Pause, live?
 */

import type { MemberHandle } from "@statewalker/httpeers-member";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Running, startService } from "../../01-upstream-kinds/src/fixtures.js";
import { createUpstream } from "../../01-upstream-kinds/src/upstreams.js";
import {
  type Relay,
  type Sharer,
  startGuest,
  startRelay,
  startSharer,
  toSharer,
} from "../../05-tab-hub-invite/src/mesh.js";
import { type ServiceEntry, serviceTable } from "../src/service-table.js";

let app: Running;
let relay: Relay;
let sharer: Sharer;
let guest: MemberHandle;
let services: ServiceEntry[];

beforeAll(async () => {
  app = await startService();
  relay = await startRelay();
  const upstream = createUpstream({ kind: "direct", target: app.origin });
  services = [
    { id: "wiki", name: "Team wiki", upstream, enabled: true, isDefault: false },
    { id: "foo", name: "fooService", upstream, enabled: true, isDefault: true },
  ];
  sharer = await startSharer({
    relayAddr: relay.addr,
    name: "Dirk",
    services: serviceTable(() => services, { sharerName: "Dirk" }),
  });
  const { id } = await sharer.invite();
  guest = await startGuest({
    relayAddr: relay.addr,
    sharerPeerId: sharer.peerId,
    invitationId: id,
  });
}, 60_000);
afterAll(async () => {
  await guest?.stop();
  await sharer?.stop();
  await relay?.stop();
  await app?.close();
});

describe("07 — what a Guest sees", () => {
  it("the catalog: every Service, the Default one first", async () => {
    const res = await guest.fetch(toSharer(sharer.peerId, "/s/"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "foo", name: "fooService", isDefault: true, paused: false },
      { id: "wiki", name: "Team wiki", isDefault: false, paused: false },
    ]);
  });

  it("Pause: the same Guest, without reconnecting, gets a paused page and a paused entry", async () => {
    const foo = services.find((s) => s.id === "foo");
    if (foo == null) throw new Error("no foo");
    foo.enabled = false;
    try {
      const page = await guest.fetch(toSharer(sharer.peerId, "/s/foo/echo/x"));
      expect(page.status).toBe(503);
      expect(page.headers.get("x-peershare-service")).toBe("paused");
      expect(await page.text()).toContain("Dirk paused fooService");

      const catalog = await (await guest.fetch(toSharer(sharer.peerId, "/s/"))).json();
      expect(catalog[0]).toMatchObject({ id: "foo", paused: true });
    } finally {
      foo.enabled = true;
    }

    const resumed = await guest.fetch(toSharer(sharer.peerId, "/s/foo/echo/x"));
    expect(resumed.status).toBe(200);
  });

  it("an unknown Service is not found, and says so as a Service would", async () => {
    const res = await guest.fetch(toSharer(sharer.peerId, "/s/nope/"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-peershare-service")).toBe("unknown");
  });

  it("the mesh view carries one PeerShare advertisement, naming the Sharer", () => {
    const ads = guest.meshView()?.advertisements ?? [];
    expect(ads.filter((a) => a.kind === "peershare")).toEqual([
      expect.objectContaining({ peerId: sharer.peerId, title: "Dirk's services" }),
    ]);
  });
});
