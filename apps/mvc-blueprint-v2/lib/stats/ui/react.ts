import { logInspectorKind } from "@stats/models";
import { reactRenderer } from "@ui/react";
import { InspectorPanel } from "./inspector-view.js";

export { InspectorPanel };
export const statsReactRenderers = [reactRenderer(logInspectorKind, InspectorPanel)];
