import { statsOverviewKind } from "@stats/models";
import { domRenderer } from "@ui/dom";
import { mountStatsView } from "./stats-view.js";

export { mountStatsView };
export const statsDomRenderers = [domRenderer(statsOverviewKind, mountStatsView)];
