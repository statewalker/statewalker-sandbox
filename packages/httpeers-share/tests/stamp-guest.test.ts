import { registerPeer } from "@statewalker/httpeers-core";
import { describe, expect, it } from "vitest";
import { stampGuest } from "../src/stamp-guest.js";
import { BRIDGE_GUEST_HEADER } from "../src/upstreams.js";

const echoGuest = stampGuest(
  async (req) => new Response(req.headers.get(BRIDGE_GUEST_HEADER) ?? "none"),
);

describe("stampGuest", () => {
  it("names the Guest the mesh proved, overwriting the one the Guest sent", async () => {
    const req = new Request("http://sharer/s/app/", {
      headers: { [BRIDGE_GUEST_HEADER]: "12D3KooWClaudia" },
    });
    registerPeer(req, "12D3KooWMarta");
    expect(await (await echoGuest(req)).text()).toBe("12D3KooWMarta");
  });

  it("names nobody for a request with no proven peer", async () => {
    const req = new Request("http://sharer/s/app/", {
      headers: { [BRIDGE_GUEST_HEADER]: "12D3KooWClaudia" },
    });
    expect(await (await echoGuest(req)).text()).toBe("none");
  });
});
