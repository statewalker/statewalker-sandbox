/**
 * 11 — What happens when a Guest cannot reach the Sharer directly?
 *
 * The Sharer is built without WebRTC, so every Guest's upgrade fails and it
 * falls back to a relay link: all its traffic crosses the public relay.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Running } from "../../01-upstream-kinds/src/fixtures.js";
import { createUpstream } from "../../01-upstream-kinds/src/upstreams.js";
import { startApp } from "../../04-probe/src/apps.js";
import {
  type Relay,
  type Sharer,
  startGuest,
  startRelay,
  startSharer,
  toSharer,
} from "../../05-tab-hub-invite/src/mesh.js";
import { serviceTable } from "../../07-advertised-services/src/service-table.js";

const ONE_MIB = "x".repeat(1 << 20);
const running: { stop(): Promise<void> }[] = [];
let page: Running;

beforeAll(async () => {
  page = await startApp({ html: ONE_MIB });
});
afterAll(async () => {
  for (const r of running.reverse()) await r.stop().catch(() => {});
  await page?.close();
});

async function relayOnlyMesh(limits: "stock" | "httpeers") {
  const relay: Relay = await startRelay({ limits });
  running.push(relay);
  const upstream = createUpstream({ kind: "direct", target: page.origin });
  const sharer: Sharer = await startSharer({
    relayAddr: relay.addr,
    webRTC: false,
    services: serviceTable(() => [
      { id: "foo", name: "foo", upstream, enabled: true, isDefault: true },
    ]),
  });
  running.push(sharer);
  const { id } = await sharer.invite();
  const guest = await startGuest({
    relayAddr: relay.addr,
    sharerPeerId: sharer.peerId,
    invitationId: id,
  });
  running.push(guest);
  return { sharer, guest };
}

describe("11 — a Guest on a relay link", () => {
  it("joins, knows it is relayed, and reaches the Services", async () => {
    const { sharer, guest } = await relayOnlyMesh("httpeers");

    expect(guest.hubLink()).toBe("relay");
    const res = await guest.fetch(toSharer(sharer.peerId, "/s/"));
    expect(res.status).toBe(200);
  }, 90_000);

  it("a 1 MiB page arrives whole through a relay with httpeers' limits", async () => {
    const { sharer, guest } = await relayOnlyMesh("httpeers");

    const res = await guest.fetch(toSharer(sharer.peerId, "/s/foo/"));
    expect((await res.text()).length).toBe(ONE_MIB.length);
  }, 90_000);

  it("RELAY FACT: a stock relay (128 KiB per relayed connection) cuts the same page off", async () => {
    const { sharer, guest } = await relayOnlyMesh("stock");

    const outcome = await guest
      .fetch(toSharer(sharer.peerId, "/s/foo/"))
      .then(async (res) => (await res.text()).length)
      .catch((e: Error) => e.name);
    expect(outcome).not.toBe(ONE_MIB.length);
  }, 90_000);
});
