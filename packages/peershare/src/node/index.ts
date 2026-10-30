/** The Node mesh platform: what tests (and a Node-hosted Sharer) use. */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { hubRelayService, membershipGater } from "@statewalker/httpeers-libp2p";
import { createLibp2p } from "libp2p";
import type { GuestIdentity, GuestStore, KeyStore, MeshPlatform } from "../public/mesh.js";

const transports = () => [webSockets(), circuitRelayTransport(), webRTC(), tcp()];

export const nodeMeshPlatform: MeshPlatform = {
  createSharerNode: ({ privateKey, isMember }) =>
    createLibp2p({
      privateKey,
      addresses: { listen: ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit", "/webrtc"] },
      transports: transports(),
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: { denyDialMultiaddr: async () => false, ...membershipGater(isMember) },
      services: { identify: identify(), relay: hubRelayService() },
    }),
  member: {
    createNode: ({ privateKey }: { privateKey?: Ed25519PrivateKey }) =>
      createLibp2p({
        ...(privateKey != null ? { privateKey } : {}),
        addresses: { listen: ["/ip4/127.0.0.1/tcp/0", "/p2p-circuit", "/webrtc"] },
        transports: transports(),
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        connectionGater: { denyDialMultiaddr: async () => false },
        services: { identify: identify() },
      }),
  },
};

/** A key kept in memory: a test's stand-in for IndexedDB. */
export function memoryKeyStore(): KeyStore & { current(): Ed25519PrivateKey | undefined } {
  let key: Ed25519PrivateKey | undefined;
  return {
    current: () => key,
    load: async () => key,
    save: async (k) => {
      key = k;
    },
    clear: async () => {
      key = undefined;
    },
  };
}

/** A Guest identity kept in memory: a test's stand-in for IndexedDB. */
export function memoryGuestStore(): GuestStore & { current(): GuestIdentity | undefined } {
  let identity: GuestIdentity | undefined;
  return {
    current: () => identity,
    load: async () => identity,
    save: async (i) => {
      identity = i;
    },
    clear: async () => {
      identity = undefined;
    },
  };
}
