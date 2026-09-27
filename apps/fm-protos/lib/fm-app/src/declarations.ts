import type { JobModel } from "@fm/core";
import { Command } from "@statewalker/shared-commands";
import { z } from "zod";
import type { PanelModel } from "./panel-model.js";

export { type FileRef, fileRef, filesCopy } from "@fm/core";

/** `ui:*` is app vocabulary. fm-core must never name it. */
export const uiShowJob = Command.required("ui:show-job")
  .input(z.custom<JobModel>())
  .output(z.unknown())
  .build();

export const panelsNavigate = Command.required("panels:navigate")
  .input(z.object({ panelId: z.string(), path: z.string() }))
  .output(z.object({ path: z.string() }))
  .label("Navigate")
  .build();

export const uiShowPanel = Command.required("ui:show-panel")
  .input(z.custom<PanelModel>())
  .output(z.object({ closed: z.boolean() }))
  .build();
