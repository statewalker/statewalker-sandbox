import type { PanelModel, PanelsModel } from "@fm/app";
import { createElement, type ReactNode } from "react";

export interface PanelSlotsProps {
  panels: PanelsModel;
  slots: Record<string, HTMLElement>;
  render(panel: PanelModel): ReactNode;
}

export interface Placement {
  panelId: string;
  slot?: string;
  /** True when the panel has no slot in this layout and must float. */
  floating: boolean;
}

/**
 * D2g — what to do with a panel the layout cannot place.
 *
 * C2 gives a panel `slot: undefined` when the layout is full, and leaves the
 * decision here: an unplaceable panel is a VIEW-LAYER problem, never an error
 * escalated to a controller. It floats — fully usable, still a drag source and
 * a drop target — rather than disappearing or throwing.
 *
 * One floats at a time. A second unplaceable panel means the layout is wrong,
 * not that we need a window manager.
 */
export function placements(panels: PanelsModel, slots: Record<string, HTMLElement>): Placement[] {
  let floated = false;
  return panels.order.map((panelId) => {
    const slot = panels.get(panelId).slot;
    const placeable = slot !== undefined && slot in slots;
    if (placeable) return { panelId, slot, floating: false };
    const floating = !floated;
    floated = true;
    return { panelId, slot: undefined, floating };
  });
}

/** The floating container is ordinary DOM: no modality, no focus trap. */
export function FloatingPanel({ children }: { children: ReactNode }) {
  return createElement(
    "div",
    { className: "fm-floating-panel", role: "region", "data-floating": "true" },
    children,
  );
}
