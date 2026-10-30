/** PeerShare as a Feature of the suite: slots and commands only. */

import { BRIDGE_MARKER, checkServiceTarget, createUpstream } from "@statewalker/httpeers-share";
import type { CommandDeclaration } from "@statewalker/shared-commands";
import { GuestManager } from "../internal/guest.manager.js";
import { Model } from "../internal/model.js";
import { SharerManager } from "../internal/sharer.manager.js";
import { SharingManager } from "../internal/sharing.manager.js";
import {
  AddService,
  CloseSession,
  EditService,
  GetGuest,
  GetSharer,
  GetSharing,
  Invite,
  Join,
  ListGuests,
  ListSharedServices,
  ProbeService,
  RemoveService,
  Resume,
  RevokeGuest,
  SetDefault,
  SetName,
  StartSharing,
  StopSharing,
  ToggleService,
} from "./commands.js";
import {
  guestFetchSlot,
  peershareModelSlot,
  sharerMountSlot,
  type UpstreamKind,
  upstreamKindsSlot,
} from "./extension-points.js";
import type { MeshInit } from "./mesh.js";
import { type AppRuntime, all, type Feature } from "./suite.js";
import type { SharerStore } from "./types.js";

export interface PeerShareInit {
  store: SharerStore;
  /** The Bridge, once paired from the Bridge's printed link. */
  bridge?: () => { base: string; token: string } | undefined;
  /** How to reach a mesh; without it PeerShare edits Services but cannot share them. */
  mesh?: MeshInit;
}

export function peershare(init: PeerShareInit): Feature {
  return {
    id: "peershare",
    label: "PeerShare",
    contribute(rt) {
      const kinds = new Map<string, UpstreamKind>();
      const stopKinds = rt.slots.observe(upstreamKindsSlot, (entries) => {
        kinds.clear();
        for (const [id, kind] of entries) kinds.set(id, kind);
      });
      // The managers report changes; the model turns them into snapshots for views.
      let changed: () => void = () => {};
      const notify = () => changed();
      const sharer = new SharerManager(init.store, () => kinds, notify);
      const sharing =
        init.mesh == null
          ? undefined
          : new SharingManager(
              init.mesh,
              sharer.mount(),
              () => sharer.snapshot().name || "The Sharer",
              notify,
            );
      const guest = init.mesh == null ? undefined : new GuestManager(init.mesh, notify);
      const model = new Model(() => ({
        sharer: sharer.snapshot(),
        sharing: sharing?.state() ?? { sharing: false },
        guests: sharing?.guests() ?? [],
        ...(sharing?.lastInvite != null ? { invite: sharing.lastInvite } : {}),
        guest: guest?.state() ?? { stage: "no-link" },
      }));
      changed = model.changed;
      /** Every command waits for the stored Sharer before acting. */
      const on =
        <P, R>(fn: (payload: P) => R | Promise<R>) =>
        async (payload: P) => {
          await sharer.ready;
          return fn(payload);
        };

      return all(
        stopKinds,
        ...builtInKinds(init).map((kind) => rt.slots.register(upstreamKindsSlot, kind.id, kind)),
        rt.slots.provide(sharerMountSlot, sharer.mount()),
        rt.slots.provide(peershareModelSlot, model),
        handle(
          rt,
          AddService,
          on((draft) => sharer.add(draft)),
        ),
        handle(
          rt,
          EditService,
          on(({ id, draft }) => sharer.edit(id, draft)),
        ),
        handle(
          rt,
          RemoveService,
          on(({ id }) => sharer.remove(id)),
        ),
        handle(
          rt,
          SetDefault,
          on(({ id }) => sharer.setDefault(id)),
        ),
        handle(
          rt,
          ToggleService,
          on(({ id, enabled }) => sharer.toggle(id, enabled)),
        ),
        handle(
          rt,
          SetName,
          on(({ name }) => sharer.setName(name)),
        ),
        handle(
          rt,
          ProbeService,
          on(({ id }) => sharer.probe(id)),
        ),
        handle(
          rt,
          GetSharer,
          on(() => sharer.snapshot()),
        ),
        ...(sharing == null ? [] : meshCommands(rt, sharer, sharing)),
        ...(guest == null ? [] : guestCommands(rt, guest)),
      );
    },
  };
}

function meshCommands(
  rt: AppRuntime,
  sharer: SharerManager,
  sharing: SharingManager,
): Array<() => void> {
  return [
    handle(rt, StartSharing, async () => {
      await sharer.ready;
      return sharing.start();
    }),
    handle(rt, StopSharing, () => sharing.stop()),
    handle(rt, GetSharing, () => sharing.state()),
    handle(rt, Invite, () => sharing.invite()),
    handle(rt, ListGuests, () => sharing.guests()),
    handle(rt, RevokeGuest, ({ peerId }) => sharing.revoke(peerId)),
    // Leaving the suite leaves the mesh.
    () => void sharing.stop(),
  ];
}

function guestCommands(rt: AppRuntime, guest: GuestManager): Array<() => void> {
  return [
    handle(rt, Join, ({ link }) => guest.join(link)),
    handle(rt, Resume, () => guest.resume()),
    handle(rt, GetGuest, () => guest.state()),
    handle(rt, ListSharedServices, () => guest.catalog()),
    handle(rt, CloseSession, () => guest.closeSession()),
    rt.slots.provide(guestFetchSlot, (serviceId, request) =>
      guest.fetchService(serviceId, request),
    ),
    // Closing the tab is not Close session: the identity stays.
    () => void guest.leave(),
  ];
}

/** The two kinds v1 ships (decision 4.1). */
function builtInKinds(init: PeerShareInit): UpstreamKind[] {
  return [
    {
      id: "bridged",
      label: "On this computer or network (through the Bridge)",
      check: (target) => checkServiceTarget("bridged", target),
      create: (target) => async (request) => {
        // Read per request: the Bridge may be paired, or re-paired, later.
        const bridge = init.bridge?.();
        if (bridge == null) {
          // The contract's own marker, so the Probe says "bridge-down", not "service-down".
          return new Response("The Bridge is not paired.", {
            status: 502,
            headers: { [BRIDGE_MARKER]: "bridge-unreachable" },
          });
        }
        return createUpstream({ kind: "bridged", target, bridge })(request);
      },
    },
    {
      id: "direct",
      label: "A website (https, with CORS)",
      check: (target) => checkServiceTarget("direct", target),
      create: (target) => createUpstream({ kind: "direct", target }),
    },
  ];
}

/** Handle `decl` on the bus and record it as handled. */
export function handle<P, R>(
  rt: AppRuntime,
  decl: CommandDeclaration<P, R>,
  fn: (payload: P) => R | Promise<R>,
): () => void {
  const stop = rt.commands.listen(decl, (cmd) => Promise.resolve(fn(cmd.payload)));
  rt.handled.set(decl as never);
  return () => {
    stop();
    rt.handled.remove(decl.key);
  };
}
