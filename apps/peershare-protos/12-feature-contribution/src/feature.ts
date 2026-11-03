/** PeerShare as a Feature of the suite: slots and commands only. */

import type { CommandDeclaration } from "@statewalker/shared-commands";
import { createUpstream } from "../../01-upstream-kinds/src/upstreams.js";
import { checkServiceTarget } from "../../04-probe/src/policy.js";
import { type ServiceEntry, serviceTable } from "../../07-advertised-services/src/service-table.js";
import { AddService, ListServices, OpenSharer, ToggleService } from "./commands.js";
import { sharerMountSlot, type UpstreamKind, upstreamKindsSlot } from "./extension-points.js";
import { type AppRuntime, all, appViewsSlot, type Feature, menuItemsSlot } from "./suite.js";

export interface PeerShareOptions {
  sharerName?: string;
  /** Where the Bridge is, once paired (rung 02's printed link). */
  bridge?: () => { base: string; token: string } | undefined;
}

export function peershareFeature(opts: PeerShareOptions = {}): Feature {
  return {
    id: "peershare",
    label: "PeerShare",
    contribute: (rt) => {
      const services: ServiceEntry[] = [];
      const kinds = new Map<string, UpstreamKind>();
      const stopKinds = rt.slots.observe(upstreamKindsSlot, (entries) => {
        kinds.clear();
        for (const [id, kind] of entries) kinds.set(id, kind);
      });

      return all(
        stopKinds,
        ...builtInKinds(opts).map((kind) => rt.slots.register(upstreamKindsSlot, kind.id, kind)),
        rt.slots.provide(
          sharerMountSlot,
          serviceTable(() => services, { sharerName: opts.sharerName ?? "The Sharer" }),
        ),

        handle(rt, OpenSharer, () => {}),
        handle(rt, AddService, (draft) => {
          const kind = kinds.get(draft.kind);
          if (kind == null) return { ok: false, reason: "unknown-kind" } as const;
          const check = kind.check(draft.target);
          if (!check.ok) return { ok: false, reason: check.reason } as const;
          const id = uniqueId(draft.name, services);
          services.push({
            id,
            name: draft.name,
            upstream: kind.create(draft.target),
            enabled: true,
            isDefault: draft.isDefault ?? services.length === 0,
          });
          return { ok: true, id } as const;
        }),
        handle(rt, ToggleService, ({ id, enabled }) => {
          const service = services.find((s) => s.id === id);
          if (service != null) service.enabled = enabled;
        }),
        handle(rt, ListServices, () =>
          services.map((s) => ({
            id: s.id,
            name: s.name,
            isDefault: s.isDefault,
            paused: !s.enabled,
          })),
        ),

        rt.slots.provide(menuItemsSlot, {
          id: "mesh.peershare",
          menu: "Mesh",
          label: "Share a local service",
          order: 40,
          command: OpenSharer.key,
        }),
        ...VIEWS.map((view) => rt.slots.register(appViewsSlot, view.id, view)),
      );
    },
  };
}

/** The two kinds v1 ships (decision 4.1), as entries of PeerShare's own extension point. */
function builtInKinds(opts: PeerShareOptions): UpstreamKind[] {
  return [
    {
      id: "bridged",
      label: "On this computer or network (through the Bridge)",
      check: (target) => checkServiceTarget("bridged", target),
      create: (target) => {
        const bridge = opts.bridge?.();
        if (bridge == null)
          return async () => new Response("The Bridge is not paired.", { status: 503 });
        return createUpstream({ kind: "bridged", target, bridge });
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

function uniqueId(name: string, services: readonly ServiceEntry[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "service";
  let id = base;
  for (let n = 2; services.some((s) => s.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** Rendered by the shell; here, descriptors (the React half is `peershare-react`). */
const VIEWS = [
  {
    id: "peershare-services",
    title: "Shared services",
    zone: "left" as const,
    render: () => "SharerServices",
  },
  { id: "peershare-viewer", title: "Viewer", zone: "center" as const, render: () => "ViewerFrame" },
  { id: "peershare-guests", title: "Guests", zone: "right" as const, render: () => "GuestList" },
];

/** Handle `decl` on the bus and record it as handled, as ui-protos' `handle` does. */
function handle<P, R>(
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
