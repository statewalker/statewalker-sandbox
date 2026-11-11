/**
 * A Feature contributed from its manifest, imported on its first command
 * (VS Code-style activation events, as shell-protos rung 05 proved for the
 * shell): the manifest's menu items and command stubs go in at once; the
 * first call of any manifest command imports the Feature, swaps the stubs
 * for the real contributions, and re-dispatches that call to them.
 */

import type { CommandDeclaration } from "@statewalker/shared-commands";
import {
  type AppRuntime,
  type Feature,
  menuItemsSlot,
} from "../../12-feature-contribution/src/suite.js";
import type { FeatureManifest } from "./manifest.js";

export function lazyFeature(manifest: FeatureManifest, load: () => Promise<Feature>): Feature {
  return {
    id: manifest.id,
    label: manifest.label,
    contribute(rt: AppRuntime) {
      let disposeReal: (() => void) | undefined;
      let activating: Promise<void> | undefined;
      const stand = manifest.menuItems.map((item) => rt.slots.provide(menuItemsSlot, item));

      const stubs = manifest.commands.map((decl) => {
        const command = decl as CommandDeclaration<unknown, unknown>;
        rt.handled.set(command);
        return rt.commands.listen(command, (cmd) =>
          activate().then(() => rt.commands.call(command, cmd.payload).promise),
        );
      });

      function activate(): Promise<void> {
        activating ??= load().then((feature) => {
          // Stubs and manifest items out, the real ones in: one set at a time.
          for (const stop of [...stubs, ...stand]) stop();
          disposeReal = feature.contribute(rt);
        });
        return activating;
      }

      return () => {
        if (disposeReal != null) disposeReal();
        else {
          for (const stop of [...stubs, ...stand]) stop();
          for (const decl of manifest.commands) rt.handled.remove(decl.key);
        }
      };
    },
  };
}
