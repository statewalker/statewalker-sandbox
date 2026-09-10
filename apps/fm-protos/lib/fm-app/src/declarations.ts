import { z } from "zod";
import { Command } from "@statewalker/shared-commands";
import type { PanelModel } from "./panel-model.js";
import type { JobModel } from "@fm/core";

export { filesCopy, fileRef, type FileRef } from "@fm/core";

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
