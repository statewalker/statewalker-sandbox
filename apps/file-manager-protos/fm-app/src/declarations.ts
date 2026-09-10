import type { JobModel } from "@fm/core";
import { Command } from "@statewalker/shared-commands";
import { z } from "zod";
import type { PanelModel } from "./panel-model.js";

export {
  ACTION_KEYS,
  type ActionKey,
  type FileRef,
  fileRef,
  filesCopy,
  filesDelete,
  filesMkdir,
  filesMove,
  filesRename,
  filesResolveActions,
} from "@fm/core";

export const panelsNavigate = Command.required("panels:navigate")
  .input(z.object({ panelId: z.string(), path: z.string() }))
  .output(z.object({ path: z.string() }))
  .label("Navigate")
  .build();

export const uiShowPanel = Command.required("ui:show-panel")
  .input(z.custom<PanelModel>())
  .output(z.object({ closed: z.boolean() }))
  .build();

/**
 * `ui:show-job` lives HERE, not in fm-core. P0 put it next to `files:copy`
 * because both concern jobs, but `files:*` is core vocabulary and `ui:*` is app
 * vocabulary — and the whole point of the conflict callback is that core runs
 * with no view layer at all. The boundary grep is what found it.
 */
export const uiShowJob = Command.required("ui:show-job")
  .input(z.custom<JobModel>())
  .output(z.unknown())
  .build();

/**
 * Coarse panel actions. Each carries a `panelId`, and **each panel controller
 * registers its own listener** rather than a central router fanning out — better
 * lifecycle hygiene, because `listen()` returns a disposer tied to the
 * controller's own lifetime. Non-matching panels return `undefined` and decline;
 * exactly one claims.
 *
 * Continuous view state is deliberately absent. The test is whether a host would
 * ever want to override it, or an agent ever want to invoke it: navigate yes,
 * cursor and scroll no.
 */
export const panelsSetSort = Command.required("panels:set-sort")
  .input(z.object({ panelId: z.string(), sortBy: z.enum(["name", "size", "date"]) }))
  .output(z.object({ sortBy: z.string() }))
  .label("Sort")
  .build();

export const panelsSelect = Command.required("panels:select")
  .input(z.object({ panelId: z.string(), paths: z.array(z.string()) }))
  .output(z.object({ selected: z.number() }))
  .label("Select")
  .build();

export const panelsRefresh = Command.required("panels:refresh")
  .input(z.object({ panelId: z.string() }))
  .output(z.object({ path: z.string() }))
  .label("Refresh")
  .build();

export const panelsClose = Command.required("panels:close")
  .input(z.object({ panelId: z.string() }))
  .output(z.object({ closed: z.boolean() }))
  .label("Close")
  .build();
