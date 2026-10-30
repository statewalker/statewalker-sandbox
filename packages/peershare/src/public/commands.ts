/** PeerShare's commands (PLAN §2.2): what menus, views, other Features and AI tools call. */

import { Command, passthrough } from "@statewalker/shared-commands";
import type { Result, ServiceDraft, SharerState } from "./types.js";

const required = <P, R>(key: string) =>
  Command.required(key).input(passthrough<P>()).output(passthrough<R>()).build();

export const SetName = required<{ name: string }, void>("peershare:set-name");
export const AddService = required<ServiceDraft, Result<{ id: string }>>("peershare:add-service");
export const EditService = required<{ id: string; draft: ServiceDraft }, Result>(
  "peershare:edit-service",
);
export const RemoveService = required<{ id: string }, void>("peershare:remove-service");
export const ToggleService = required<{ id: string; enabled: boolean }, void>(
  "peershare:toggle-service",
);
export const SetDefault = required<{ id: string }, void>("peershare:set-default");
export const ProbeService = required<{ id: string }, void>("peershare:probe");
export const GetSharer = required<void, SharerState>("peershare:get-sharer");
