/**
 * The Sharer on its own mesh: it IS the hub (ADR 0001). Everything the
 * prototype rungs found is here: revocations enforced (rung 09), Guests on
 * relay links served (rung 11), Guests named for the Bridge's cookie jars
 * (rung 16), one static advertisement with the live catalog at `/s/` (rung 07).
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Libp2p } from "@libp2p/interface";
import { selfCertifyingKeys, withAccess } from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import { ANONYMOUS, type FetchHandler, lookupPeer } from "@statewalker/httpeers-core";
import { createHub, type Hub, usesTransportIdentity } from "@statewalker/httpeers-hub";
import {
  dialRelay,
  type Peer,
  servePeer,
  signerOf,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";
import { encodeInvite, revokeGuest, stampGuest } from "@statewalker/httpeers-share";
import type { GuestRecord, SharingState } from "../public/commands.js";
import type { MeshInit } from "../public/mesh.js";
import { INVITE_TTL_MS, PEERSHARE_RULES } from "./rules.js";

interface Running {
  node: Libp2p;
  hub: Hub;
  peer: Peer;
}

export class SharingManager {
  private running: Running | undefined;
  private peerId: string | undefined;

  constructor(
    private readonly mesh: MeshInit,
    private readonly mount: FetchHandler,
    private readonly sharerName: () => string,
  ) {}

  state(): SharingState {
    return {
      sharing: this.running != null,
      ...(this.peerId != null ? { peerId: this.peerId } : {}),
    };
  }

  async start(): Promise<SharingState> {
    if (this.running != null) return this.state();
    const { platform, relayAddrs, sharerKey, hubStorage } = this.mesh;
    let privateKey = await sharerKey.load();
    if (privateKey == null) {
      privateKey = await generateKeyPair("Ed25519");
      await sharerKey.save(privateKey);
    }

    let isMember: (id: string) => boolean = () => false;
    const node = await platform.createSharerNode({ privateKey, isMember: () => isMember });
    const peerId = node.peerId.toString();
    for (const addr of relayAddrs) await dialRelay(node, addr);
    await waitForCircuitReservation(node);

    const signer = signerOf(privateKey);
    const hub = await createHub({
      selfPeerId: peerId,
      policies: PEERSHARE_RULES,
      storage: hubStorage,
      mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs: 10 * 60_000 }),
      extraMounts: { "/s": stampGuest(this.mount) },
      ownAdvertisements: [
        { id: "peershare", kind: "peershare", title: `${this.sharerName()}'s services` },
      ],
    });
    isMember = (id) => hub.isMember(id);

    const peer = await servePeer({
      node,
      mounts: hub.mounts,
      access: withAccess({
        issuer: peerId,
        rules: PEERSHARE_RULES,
        selfPeer: peerId,
        keys: selfCertifyingKeys(),
        provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
        bootstrap: usesTransportIdentity(),
        revocation: hub.revocations,
      }),
      serveOnLimitedConnection: true,
    });

    this.running = { node, hub, peer };
    this.peerId = peerId;
    return this.state();
  }

  async stop(): Promise<SharingState> {
    const running = this.running;
    this.running = undefined;
    if (running != null) {
      for (const step of [
        () => running.peer.stop(),
        () => running.hub.stop(),
        () => running.node.stop(),
      ]) {
        await Promise.resolve()
          .then(step)
          .catch(() => {});
      }
    }
    return this.state();
  }

  /** A one-time Invite to all the Sharer's Services, valid 24 h (rungs 05, 06). */
  async invite(): Promise<{ url: string; expiresAt: number }> {
    const hub = this.required().hub;
    const { id, expiresAt } = await hub.invitations.create(["guest"], INVITE_TTL_MS);
    const url = encodeInvite(this.mesh.invitePage, {
      relayAddrs: this.mesh.relayAddrs,
      sharerPeerId: this.peerId as string,
      invitationId: id,
      sharerName: this.sharerName(),
    });
    return { url, expiresAt };
  }

  guests(): GuestRecord[] {
    return (this.running?.hub.members.list() ?? []).map((m) => ({ peerId: m.peerId }));
  }

  revoke(peerId: string): void {
    revokeGuest(this.required().hub, peerId);
  }

  private required(): Running {
    if (this.running == null) throw new Error("PeerShare is not sharing: start it first.");
    return this.running;
  }
}
