/** PeerShare as a Feature of the suite: slots and commands only. */

import { BRIDGE_MARKER, checkServiceTarget, createUpstream } from "@statewalker/httpeers-share";
import type { CommandDeclaration } from "@statewalker/shared-commands";
import { SharerManager } from "../internal/sharer.manager.js";
import {
  AddService,
  EditService,
  GetSharer,
  ProbeService,
  RemoveService,
  SetDefault,
  SetName,
  ToggleService,
} from "./commands.js";
import { sharerMountSlot, type UpstreamKind, upstreamKindsSlot } from "./extension-points.js";
import { type AppRuntime, all, type Feature } from "./suite.js";
import type { SharerStore } from "./types.js";

export interface PeerShareInit {
  store: SharerStore;
  /** The Bridge, once paired from the Bridge's printed link. */
  bridge?: () => { base: string; token: string } | undefined;
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
      const sharer = new SharerManager(init.store, () => kinds);
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
      );
    },
  };
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
