/**
 * The page. One file, two roles, chosen by URL — so both tabs load the same
 * bundle and any asymmetry between them is in the parameters rather than in
 * the code.
 *
 *   ?role=hub                 become a hub, mint an invitation, publish a join link
 *   ?join=<blob>              join that hub, then exercise the cycle
 *   &relay=<url|multiaddr>    which relay to meet on (defaults to the public one)
 *
 * WHY THE GUEST DRIVES THE ASSERTIONS. The guest is the peer that has to
 * discover everything: it starts knowing only a blob. If the cycle completes
 * from its side, every part of the path worked — bootstrap discovery,
 * reservation, circuit, WebRTC upgrade, invitation redemption, membership,
 * and calls in both directions. The hub only has to exist and answer.
 *
 * `window.__mesh` is the seam the Playwright spec reads. Everything it
 * exposes is also rendered on the page, so the test and a human watching
 * two tabs see the same thing.
 */

import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import {
  type Advertisement,
  decodeJoinBlob,
  encodeJoinBlob,
  guestHandler,
  hubHandler,
  joinMesh,
  mintInvitation,
  newHubState,
} from "./hub.js";
import { startPeer } from "./mesh.js";

/**
 * The deployed relay, as a URL. Override with `&relay=` to point at a local
 * one, in either form — a URL or a multiaddr.
 *
 * A URL, not a multiaddr: the relay publishes its addresses (peer id included)
 * at `/.well-known/httpeers-relay.json`, so nothing here has to be kept in
 * step with a deployment by hand. The previous hardcoded
 * `/dns4/relay.httpeers.net/tcp/443/tls/ws` was missing the peer id entirely,
 * which would have authenticated nothing.
 */
const DEFAULT_RELAY = "https://relay.httpeers.net";

declare global {
  interface Window {
    __mesh?: {
      role: "hub" | "guest";
      ready: boolean;
      peerId?: string;
      address?: string;
      joinUrl?: string;
      joinBlob?: string;
      results?: { label: string; ok: boolean; detail?: string }[];
      error?: string;
    };
  }
}

const params = new URLSearchParams(location.search);
const relay = params.get("relay") ?? DEFAULT_RELAY;
const joinParam = params.get("join");
const role = joinParam != null ? "guest" : "hub";

const statusEl = document.getElementById("status") as HTMLElement;
const joinEl = document.getElementById("join") as HTMLElement;
const logEl = document.getElementById("log") as HTMLElement;

window.__mesh = { role, ready: false, results: [] };

function log(line: string): void {
  logEl.textContent += `${line}\n`;
}

function record(label: string, ok: boolean, detail?: string): void {
  window.__mesh?.results?.push({ label, ok, detail });
  const span = document.createElement("span");
  span.className = ok ? "pass" : "fail";
  span.textContent = `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}\n`;
  logEl.append(span);
}

// The browser peer adds `webRTC()`; the Node harness does not. That single
// difference is why a browser pair leaves the relay after ICE and a Node
// pair does not.
const transports = [webSockets(), webRTC()];

async function runHub(): Promise<void> {
  statusEl.textContent = "reserving a slot on the relay…";
  const state = newHubState();
  const peer = await startPeer({ relay, transports, handler: hubHandler(state, "hub-tab") });

  const invitationId = mintInvitation(state);
  const blob = encodeJoinBlob({ relay, hubAddress: peer.address, invitationId });
  const joinUrl = `${location.origin}${location.pathname}?join=${blob}${
    params.get("relay") != null ? `&relay=${encodeURIComponent(relay)}` : ""
  }`;

  Object.assign(window.__mesh ?? {}, {
    ready: true,
    peerId: peer.peerId,
    address: peer.address,
    joinUrl,
    joinBlob: blob,
  });

  statusEl.textContent = "hub is up — open the join link in a second tab";
  const link = document.createElement("a");
  link.href = joinUrl;
  link.id = "join-url";
  link.textContent = joinUrl;
  joinEl.append(link);

  log(`relay   ${peer.relayAddrs.join(", ")}`);
  log(`peerId  ${peer.peerId}`);
  log(`address ${peer.address}`);

  // Membership changes are the only thing the hub tab has to show: it is
  // otherwise a passive party in this test.
  setInterval(() => {
    statusEl.textContent = `hub is up — members: ${state.members.size}`;
  }, 500);
}

async function runGuest(blobParam: string): Promise<void> {
  statusEl.textContent = "reserving a slot on the relay…";
  const blob = decodeJoinBlob(blobParam);
  const peer = await startPeer({
    relay: blob.relay,
    transports,
    handler: guestHandler("guest-tab"),
  });
  Object.assign(window.__mesh ?? {}, { peerId: peer.peerId, address: peer.address });
  log(`relay   ${peer.relayAddrs.join(", ")}`);
  log(`peerId  ${peer.peerId}`);
  log(`address ${peer.address}`);
  record("the relay's addresses were discovered from its URL", peer.relayAddrs.length > 0);
  record("guest obtained a reservation", peer.address.includes("/p2p-circuit"));

  statusEl.textContent = "joining…";
  const before = await peer.fetch(blob.hubAddress, new Request("http://hub/hello"));
  record("a peer that has not joined is refused", before.status === 403, `status ${before.status}`);

  const joined = await joinMesh(peer, blob, { kind: "echo", path: "/echo" });
  record("guest redeemed the invitation", joined.hub === "hub-tab");

  const helloRes = await peer.fetch(blob.hubAddress, new Request("http://hub/hello"));
  const hello = (await helloRes.json()) as { from?: string; greeting?: string };
  record("guest consumed the hub's resource", hello.from === "hub-tab", hello.greeting);

  const meshRes = await peer.fetch(blob.hubAddress, new Request("http://hub/.well-known/mesh"));
  const mesh = (await meshRes.json()) as {
    advertisements: (Advertisement & { peerId: string })[];
  };
  const ad = mesh.advertisements.find((a) => a.peerId === peer.peerId);
  record("the guest's own resource is advertised in the mesh view", ad?.kind === "echo");

  statusEl.textContent = "done";
  const ok = (window.__mesh?.results ?? []).every((r) => r.ok);
  window.__mesh = { ...(window.__mesh ?? { role: "guest", ready: false }), ready: true };
  statusEl.textContent = ok ? "all claims hold" : "some claims failed";
}

const run = role === "hub" ? runHub() : runGuest(joinParam as string);
run.catch((err: Error) => {
  statusEl.textContent = `error: ${err.message}`;
  record("run completed", false, err.message);
  window.__mesh = {
    ...(window.__mesh ?? { role, ready: false }),
    ready: true,
    error: err.message,
  };
});
