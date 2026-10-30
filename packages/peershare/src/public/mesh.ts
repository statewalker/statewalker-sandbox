/** What PeerShare needs from the platform to put the Sharer and the Guest on a mesh. */

import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import type { KeyValueStorage } from "@statewalker/httpeers-hub";
import type { MemberPlatform } from "@statewalker/httpeers-member";

export interface MeshPlatform {
  /**
   * The Sharer's node: it is the hub of its own mesh, so it listens for
   * circuits and WebRTC upgrades and relays for its Guests. `isMember` is
   * the hub's current answer, for the connection gater.
   */
  createSharerNode(init: {
    privateKey: Ed25519PrivateKey;
    isMember: () => (peerId: string) => boolean;
  }): Promise<Libp2p>;
  /** A Guest's member platform (httpeers-member). */
  member: MemberPlatform;
}

/** Where a private key survives a reload (IndexedDB in the page). */
export interface KeyStore {
  load(): Promise<Ed25519PrivateKey | undefined>;
  save(key: Ed25519PrivateKey): Promise<void>;
  clear(): Promise<void>;
}

export interface MeshInit {
  platform: MeshPlatform;
  relayAddrs: string[];
  /** The page Invites open: `https://tools.sandclaw.ai/peer-share/invite`. */
  invitePage: string;
  sharerKey: KeyStore;
  /** The hub's members and spent Invites; must survive a reload with the key (rung 09). */
  hubStorage: KeyValueStorage;
  /** The Guest's identity and whose mesh it belongs to; Close session clears it (rung 10). */
  guestStore: GuestStore;
}

export interface GuestIdentity {
  privateKey: Ed25519PrivateKey;
  sharerPeerId: string;
  sharerName: string;
  relayAddrs: string[];
}

export interface GuestStore {
  load(): Promise<GuestIdentity | undefined>;
  save(identity: GuestIdentity): Promise<void>;
  clear(): Promise<void>;
}
