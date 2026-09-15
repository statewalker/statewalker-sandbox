import { progressBarKind } from "@progress/models";
import { domRenderer } from "@ui/dom";
import { mountProgressView } from "./progress-view.js";

export { mountProgressView };
export const progressDomRenderers = [domRenderer(progressBarKind, mountProgressView)];
