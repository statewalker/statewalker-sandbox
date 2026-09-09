import { Command } from "@statewalker/shared-commands";
import { z } from "zod";
import type { JobModel } from "@fm/core";
import type { PanelModel } from "./panel-model.js";

export { fileRef, filesCopy, type FileRef } from "@fm/core";

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
