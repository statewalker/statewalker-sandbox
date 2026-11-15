import { generateKeyPair } from "@libp2p/crypto/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserNode } from "../src/browser/node-profile.js";
import { createHubNode } from "../src/hub/node-profile.js";
import { ICE_SERVERS, MESH_STUN_URL, PUBLIC_STUN_FALLBACK_URL } from "../src/ice-servers.js";

// Records the init each node profile passes to `webRTC()`, and still builds the real transport.
const webRTCInits = vi.hoisted(() => [] as unknown[]);
vi.mock("@libp2p/webrtc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libp2p/webrtc")>();
  return {
    ...actual,
    webRTC: (init?: Parameters<typeof actual.webRTC>[0]) => {
      webRTCInits.push(init);
      return actual.webRTC(init);
    },
  };
});

afterEach(() => {
  webRTCInits.length = 0;
});

/**
 * The one `webRTC()` call got `ICE_SERVERS`, as entries it may modify: on Node,
 * node-datachannel rewrites each entry's `urls` in place and throws on a frozen one.
 */
function expectIceServersPassed() {
  expect(webRTCInits).toEqual([{ rtcConfiguration: { iceServers: [...ICE_SERVERS] } }]);
  const [init] = webRTCInits as { rtcConfiguration: { iceServers: object[] } }[];
  for (const entry of init?.rtcConfiguration.iceServers ?? [])
    expect(Object.isFrozen(entry)).toBe(false);
}

describe("ICE servers", () => {
  it("puts the mesh's own STUN server first, with one public fallback behind it", () => {
    expect(MESH_STUN_URL).toBe("stun:stun.httpeers.net:3478");
    expect(ICE_SERVERS.map((s) => s.urls)).toEqual([MESH_STUN_URL, PUBLIC_STUN_FALLBACK_URL]);
    expect(PUBLIC_STUN_FALLBACK_URL).toMatch(/^stun:/);
    expect(PUBLIC_STUN_FALLBACK_URL).not.toContain("httpeers.net");
  });

  it("the hub node's WebRTC transport asks those servers", async () => {
    const node = await createHubNode({ privateKey: await generateKeyPair("Ed25519") });
    try {
      expectIceServersPassed();
    } finally {
      await node.stop();
    }
  });

  it("the browser node's WebRTC transport asks those servers", async () => {
    const node = await createBrowserNode({
      dev: false,
      privateKey: await generateKeyPair("Ed25519"),
    });
    try {
      expectIceServersPassed();
    } finally {
      await node.stop();
    }
  });
});
