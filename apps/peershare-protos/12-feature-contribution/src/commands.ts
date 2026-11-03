/** PeerShare's commands (PLAN §2.2): what menus, views, other Features and AI tools call. */

import { Command, passthrough } from "@statewalker/shared-commands";
import type { TargetRefusal } from "../../04-probe/src/policy.js";
import type { CatalogEntry } from "../../07-advertised-services/src/service-table.js";

export interface ServiceDraft {
  name: string;
  /** An id of the `peershare:upstream-kinds` extension point: "bridged", "direct", or another Feature's. */
  kind: string;
  target: string;
  isDefault?: boolean;
}

/** `reason`: a `TargetRefusal` for the built-in kinds, `"unknown-kind"`, or another kind's own. */
export type AddServiceResult =
  | { ok: true; id: string }
  | { ok: false; reason: TargetRefusal | "unknown-kind" | (string & {}) };

export const OpenSharer = Command.silent("peershare:open-sharer")
  .input(passthrough<void>())
  .output(passthrough<void>())
  .label("Share a local service")
  .build();

export const AddService = Command.required("peershare:add-service")
  .input(passthrough<ServiceDraft>())
  .output(passthrough<AddServiceResult>())
  .build();

export const ToggleService = Command.required("peershare:toggle-service")
  .input(passthrough<{ id: string; enabled: boolean }>())
  .output(passthrough<void>())
  .build();

export const ListServices = Command.required("peershare:list-services")
  .input(passthrough<void>())
  .output(passthrough<CatalogEntry[]>())
  .build();
