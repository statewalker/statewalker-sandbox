/**
 * The browser: the Sharer's node is httpeers-member's browser profile with a
 * membership gater (a hub in a tab, ADR 0001); a Guest's member needs no
 * ServiceWorker edge, because PeerShare calls the mesh through the member's
 * JavaScript `fetch` (rung 08). State lives in IndexedDB.
 */

import { privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { idbStorage } from "@statewalker/httpeers-hub/browser";
import { createBrowserNode } from "@statewalker/httpeers-member/browser";
import { createStore, del, get, set, type UseStore } from "idb-keyval";
import type {
  GuestIdentity,
  GuestStore,
  KeyStore,
  MeshInit,
  MeshPlatform,
} from "../public/mesh.js";
import type { SharerState, SharerStore } from "../public/types.js";

/** `dev` lets the browser dial a plain `ws://` relay on loopback (a developer's machine, a test). */
export function browserMeshPlatform(init: { dev?: boolean } = {}): MeshPlatform {
  const dev = init.dev ?? false;
  return {
    createSharerNode: ({ privateKey, isMember }) =>
      createBrowserNode({ dev, privateKey, isMember: (peerId) => isMember()(peerId) }),
    member: {
      createNode: ({ privateKey }) => {
        if (privateKey == null) throw new Error("PeerShare always gives a Guest its key.");
        return createBrowserNode({ dev, privateKey });
      },
    },
  };
}

const DB = "peershare";

function store(): UseStore {
  return createStore(DB, "state");
}

/** The Sharer's name and Services, in IndexedDB. */
export function idbSharerStore(): SharerStore {
  const db = store();
  return {
    load: async () => (await get<SharerState>("sharer", db)) ?? undefined,
    save: async (state) => set("sharer", state, db),
  };
}

/** A private key in IndexedDB, as protobuf bytes. */
export function idbKeyStore(name: string): KeyStore {
  const db = store();
  return {
    load: async () => {
      const bytes = await get<Uint8Array>(`key:${name}`, db);
      return bytes == null ? undefined : (privateKeyFromProtobuf(bytes) as Ed25519PrivateKey);
    },
    save: (key) => set(`key:${name}`, privateKeyToProtobuf(key), db),
    clear: () => del(`key:${name}`, db),
  };
}

interface StoredGuest extends Omit<GuestIdentity, "privateKey"> {
  privateKey: Uint8Array;
}

/** The Guest's identity and whose mesh it belongs to; Close session clears it. */
export function idbGuestStore(): GuestStore {
  const db = store();
  return {
    load: async () => {
      const stored = await get<StoredGuest>("guest", db);
      if (stored == null) return undefined;
      return {
        ...stored,
        privateKey: privateKeyFromProtobuf(stored.privateKey) as Ed25519PrivateKey,
      };
    },
    save: (identity) =>
      set("guest", { ...identity, privateKey: privateKeyToProtobuf(identity.privateKey) }, db),
    clear: () => del("guest", db),
  };
}

/** Everything `peershare({ mesh })` needs in a page. */
export function browserMesh(init: {
  relayAddrs: string[];
  invitePage: string;
  dev?: boolean;
}): MeshInit {
  return {
    platform: browserMeshPlatform({ dev: init.dev ?? false }),
    relayAddrs: init.relayAddrs,
    invitePage: init.invitePage,
    sharerKey: idbKeyStore("sharer"),
    hubStorage: idbStorage("peershare-hub"),
    guestStore: idbGuestStore(),
  };
}
