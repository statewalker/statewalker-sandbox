/**
 * PeerShare's manifest: what it contributes, as DATA. The shell renders this
 * without importing PeerShare (shell-protos rungs 04/05). Command
 * declarations are data too (a key and schemas), so they are imported here;
 * the Feature's code is not.
 */

import {
  AddService,
  ListServices,
  OpenSharer,
  ToggleService,
} from "../../12-feature-contribution/src/commands.js";
import type { AppMenuItem } from "../../12-feature-contribution/src/suite.js";

export interface FeatureManifest {
  id: string;
  label: string;
  menuItems: AppMenuItem[];
  /** Activation events: the first call of any of these imports the Feature. */
  commands: { key: string }[];
}

export const PEERSHARE_MANIFEST: FeatureManifest = {
  id: "peershare",
  label: "PeerShare",
  menuItems: [
    {
      id: "mesh.peershare",
      menu: "Mesh",
      label: "Share a local service",
      order: 40,
      command: OpenSharer.key,
    },
  ],
  commands: [OpenSharer, AddService, ToggleService, ListServices],
};
