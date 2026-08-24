/**
 * The mesh this origin last joined -- `{ relayAddrs: [{ addr, subnetwork }],
 * hubPeerId }`, kept
 * beside the identity key it belongs to.
 *
 * WHY A PAGE HAS TO REMEMBER THIS AT ALL (Task 28). A page that resumes a
 * membership needs two things: the identity that holds it
 * (`./identity.ts`) and the mesh that granted it. The first has persisted
 * since Task 24. The second has not, and for the Node hub it did not need
 * to -- `httpeers.json` names that mesh on every origin, forever. For a
 * mesh whose hub is a BROWSER PAGE it does need to: that hub's peerId
 * exists only in a tab's IndexedDB and reaches other pages exactly once, in
 * the join blob that admitted them (`./join-blob.ts`). Reload such a page
 * without its `?join=` query and it holds a membership in a mesh it can no
 * longer name. This module is that missing half -- and it is genuinely only
 * a memory: nothing here is a credential, and every field in it was
 * published in the blob anyway.
 *
 * WHAT IT DOES NOT CHANGE: WHAT A BARE INVITATION ID MEANS. `./join-blob.ts`
 * is explicit that a `?invite=` id with no blob means "the mesh
 * `httpeers.json` names", i.e. the Node hub's -- both deployments are
 * supported deliberately. So this memory is consulted ONLY when resuming
 * (no invitation in hand). The moment someone supplies an invitation, the
 * invitation decides: a blob names its own mesh, and a bare id still means
 * the deployment's. Reversing that would have silently pointed the Node-hub
 * path at whatever mesh the page had last seen. See `./session.ts`, which
 * is where the two rules meet.
 *
 * WRITTEN ONLY AFTER A JOIN ACTUALLY SUCCEEDS. A remembered mesh that was
 * never reachable would turn one failed paste into a page that keeps
 * failing the same way on every later load, with the operator's original
 * mistake no longer visible anywhere.
 */
import type { RelayEntry } from "../reservation.js";
import type { AsyncKeyValueBackend } from "./kv.js";
import { idbBackend } from "./kv.js";
import type { HttpeersConfig } from "./peer-runtime.js";

/** Where the remembered mesh lives, namespaced like `./identity.ts`'s key and `./snapshot-store.ts`'s snapshot. */
export const MESH_STORAGE_KEY = "httpeers:mesh";

export interface MeshMemory {
  /** The mesh this origin last joined, or `null` -- also `null` when the stored value is unreadable; see `parseMesh`. */
  read(): Promise<HttpeersConfig | null>;
  write(config: HttpeersConfig): Promise<void>;
  clear(): Promise<void>;
}

export interface CreateMeshMemoryInit {
  /** Defaults to `idbBackend()` -- the real IndexedDB. Overridden by tests. */
  backend?: AsyncKeyValueBackend;
  /** Defaults to `MESH_STORAGE_KEY`. */
  storageKey?: string;
}

/**
 * Validate rather than trust, and return `null` rather than throw.
 *
 * The same tolerance `./snapshot-store.ts` applies to a corrupt snapshot,
 * for the same reason and with a smaller cost: a page whose remembered mesh
 * is unreadable has simply not got one, which is the first-run state it
 * already knows how to render (say so, offer the invitation field). Throwing
 * would take out the page -- including the reset control -- over a value
 * that is a convenience.
 */
function parseMesh(raw: string | undefined): HttpeersConfig | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HttpeersConfig>;
    const relayAddrs = parsed.relayAddrs;
    if (!Array.isArray(relayAddrs) || relayAddrs.length === 0) return null;
    // A memory written before subnetworks existed names an address and no
    // name, so resuming from it would be refused a reservation. It is not
    // readable, in the only sense this function cares about.
    for (const entry of relayAddrs as Array<Partial<RelayEntry> | string>) {
      if (typeof entry !== "object" || entry == null) return null;
      if (typeof entry.addr !== "string" || entry.addr === "") return null;
      if (typeof entry.subnetwork !== "string" || entry.subnetwork === "") return null;
    }
    if (typeof parsed.hubPeerId !== "string" || parsed.hubPeerId === "") return null;
    return { relayAddrs, hubPeerId: parsed.hubPeerId };
  } catch (err) {
    console.warn(
      `mesh-memory: the stored mesh at "${MESH_STORAGE_KEY}" is not readable JSON -- this page ` +
        "will ask for an invitation instead of resuming.",
      err,
    );
    return null;
  }
}

export function createMeshMemory(init: CreateMeshMemoryInit = {}): MeshMemory {
  const backend = init.backend ?? idbBackend();
  const storageKey = init.storageKey ?? MESH_STORAGE_KEY;

  return {
    async read() {
      return parseMesh(await backend.get(storageKey));
    },
    async write(config) {
      await backend.set(storageKey, JSON.stringify(config));
    },
    async clear() {
      await backend.del(storageKey);
    },
  };
}
