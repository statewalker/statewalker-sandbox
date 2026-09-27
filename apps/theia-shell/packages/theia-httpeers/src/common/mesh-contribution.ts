import type { createMounts } from "@statewalker/httpeers-core";

/** The member's mount table: `provide(prefix, handler)` serves a handler on the mesh. */
export type MeshMounts = ReturnType<typeof createMounts>;

/**
 * What another extension serves on the mesh from this browser.
 *
 * The member has ONE mount table and ONE advertisement list, both fixed
 * when the session is created, so a contribution gets its say before that:
 * `configureMounts` runs once, before the session starts. A handler it
 * provides can delegate to state that changes later (the proxy's route
 * table does). `advertisements` is read again on every heartbeat, so what
 * a peer offers can come and go without restarting anything.
 *
 * Every path provided here also needs a policy in `shellRules()`: an
 * unmatched path is denied, whoever calls it.
 */
/** What a heartbeat advertises: `startMember`'s advertisement input, by shape. */
export interface MeshAdvertisement {
  id: string;
  kind: string;
  title: string;
}

export const MeshContribution = Symbol("MeshContribution");
export interface MeshContribution {
  configureMounts?(mounts: MeshMounts): void;
  advertisements?(): MeshAdvertisement[];
}
