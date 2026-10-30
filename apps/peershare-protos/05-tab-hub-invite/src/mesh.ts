/**
 * A real PeerShare mesh in one process: a relay, the Sharer (who IS the hub
 * of its own mesh, ADR 0001) and Guests. No stubs: libp2p, WebRTC, Biscuit
 * tokens, the published `@statewalker/httpeers-*` packages.
 *
 * Modelled on httpeers' `packages/httpeers-conformance/tests/mesh-harness.ts`
 * (the proven recipe); the differences are PeerShare's: the hub's rules know a
 * `guest` role, and the hub mounts the Sharer's Services at `/s`.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { ruleSet, selfCertifyingKeys, withAccess } from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import { ANONYMOUS, createMounts, type FetchHandler, lookupPeer } from "@statewalker/httpeers-core";
import {
  createHub,
  type Hub,
  type KeyValueStorage,
  memoryStorage,
  usesTransportIdentity,
} from "@statewalker/httpeers-hub";
import {
  dialRelay,
  hubRelayService,
  membershipGater,
  type Peer,
  servePeer,
  signerOf,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";
import { type MemberHandle, startMember } from "@statewalker/httpeers-member";
import { createLibp2p } from "libp2p";

/**
 * PeerShare's rules. A Guest may reach the Sharer's Services (`/s/…`) and the
 * hub endpoints a member needs to stay a member (`/.well-known/…`), nothing
 * else: no `/admin`, no other mount.
 */
export const PEERSHARE_RULES = ruleSet({
  version: 1,
  rules: ['capability("peershare:view") <- role("guest");'],
  policies: [
    'allow if capability("peershare:view"), resource($r), $r.starts_with("/s/");',
    'allow if capability("peershare:view"), resource($r), $r.starts_with("/.well-known/");',
  ],
});

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const PRESENCE_TTL_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 800;

function transports() {
  return [webSockets(), circuitRelayTransport(), webRTC(), tcp()];
}

export interface Relay {
  addr: string;
  stop(): Promise<void>;
}

/**
 * A Circuit Relay v2 server. `limits: "stock"` is libp2p's default (a relayed
 * connection carries 128 KiB or lasts 2 minutes); `"httpeers"` is what
 * `httpeers/apps/relay` deploys (1 GiB, 6 hours).
 */
export async function startRelay(opts: { limits?: "stock" | "httpeers" } = {}): Promise<Relay> {
  const limits =
    opts.limits === "httpeers"
      ? { defaultDataLimit: 1n << 30n, defaultDurationLimit: 6 * 60 * 60 * 1000 }
      : {};
  const node = await createLibp2p({
    privateKey: await generateKeyPair("Ed25519"),
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer({ reservations: { applyDefaultLimit: true, ...limits } }),
    },
  });
  const addr = node
    .getMultiaddrs()
    .map(String)
    .find((a) => a.includes("/ws/"));
  if (addr == null) throw new Error("relay has no ws address");
  return {
    addr,
    stop: async () => {
      await node.stop();
    },
  };
}

export interface SharerInit {
  relayAddr: string;
  /** The Sharer's `/s` mount: rung 01's `shareRouter`. */
  services: FetchHandler;
  name?: string;
  /** Kept across a reload: the Sharer's identity and its hub's members. */
  privateKey?: Ed25519PrivateKey;
  storage?: KeyValueStorage;
  now?: () => number;
  /**
   * `false` builds the Sharer with no WebRTC transport, so a Guest's upgrade
   * fails at signalling and it falls back to a relay link: what a Guest behind
   * a NAT WebRTC cannot cross gets.
   */
  webRTC?: boolean;
}

export interface Sharer {
  peerId: string;
  hub: Hub;
  privateKey: Ed25519PrivateKey;
  storage: KeyValueStorage;
  node: Libp2p;
  /** A one-time Invite for all the Sharer's Services, valid 24 h. */
  invite(): Promise<{ id: string; expiresAt: number }>;
  stop(): Promise<void>;
}

export async function startSharer(init: SharerInit): Promise<Sharer> {
  const privateKey = init.privateKey ?? (await generateKeyPair("Ed25519"));
  const storage = init.storage ?? memoryStorage();
  let isMember: (id: string) => boolean = () => false;

  const webRTCOn = init.webRTC ?? true;
  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: webRTCOn
        ? ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit", "/webrtc"]
        : ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit"],
    },
    transports: webRTCOn ? transports() : [webSockets(), circuitRelayTransport(), tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
      ...membershipGater(() => isMember),
    },
    services: { identify: identify(), relay: hubRelayService() },
  });
  const peerId = node.peerId.toString();
  await dialRelay(node, init.relayAddr);
  await waitForCircuitReservation(node);

  const signer = signerOf(privateKey);
  const hub = await createHub({
    selfPeerId: peerId,
    policies: PEERSHARE_RULES,
    storage,
    presenceTtlMs: PRESENCE_TTL_MS,
    ...(init.now != null ? { now: init.now } : {}),
    mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs: 10 * 60_000 }),
    extraMounts: { "/s": init.services },
    ownAdvertisements: [
      { id: "peershare", kind: "peershare", title: `${init.name ?? "Sharer"}'s services` },
    ],
  });
  isMember = (id) => hub.isMember(id);

  const peer: Peer = await servePeer({
    node,
    mounts: hub.mounts,
    access: withAccess({
      issuer: peerId,
      rules: PEERSHARE_RULES,
      selfPeer: peerId,
      keys: selfCertifyingKeys(),
      provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
      bootstrap: usesTransportIdentity(),
      // Without this, Revoke is recorded and never enforced: the Guest's
      // token keeps verifying until it expires (found in rung 09).
      revocation: hub.revocations,
    }),
    // A Guest whose WebRTC upgrade fails reaches the Sharer only over a
    // relay circuit, which libp2p marks "limited"; refused, such a Guest
    // cannot even join (found in rung 11).
    serveOnLimitedConnection: true,
  });

  return {
    peerId,
    hub,
    privateKey,
    storage,
    node,
    invite: () => hub.invitations.create(["guest"], INVITE_TTL_MS),
    async stop() {
      for (const step of [() => peer.stop(), () => hub.stop(), () => node.stop()]) {
        await Promise.resolve()
          .then(step)
          .catch(() => {});
      }
    },
  };
}

export interface GuestInit {
  relayAddr: string;
  sharerPeerId: string;
  /** Omit to resume a membership this identity already has. */
  invitationId?: string;
  privateKey?: Ed25519PrivateKey;
}

/** A Guest: a member of the Sharer's mesh, serving nothing of its own. */
export function startGuest(init: GuestInit): Promise<MemberHandle> {
  return startMember({
    key: "peers",
    mounts: createMounts(),
    rules: PEERSHARE_RULES,
    config: { relayAddrs: [init.relayAddr], hubPeerId: init.sharerPeerId },
    platform: { createNode: ({ privateKey }) => guestNode(privateKey) },
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    ...(init.invitationId != null ? { invitationId: init.invitationId } : {}),
    ...(init.privateKey != null ? { privateKey: init.privateKey } : {}),
  });
}

function guestNode(privateKey?: Ed25519PrivateKey): Promise<Libp2p> {
  return createLibp2p({
    ...(privateKey != null ? { privateKey } : {}),
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit", "/webrtc"] },
    transports: transports(),
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: async () => false },
    services: { identify: identify() },
  });
}

/** What a Guest's request to the Sharer looks like: addressed by peer id. */
export function toSharer(sharerPeerId: string, path: string, init?: RequestInit): Request {
  return new Request(`http://local/peers/${sharerPeerId}${path}`, init);
}
