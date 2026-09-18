/**
 * Shell API, React sub-module — the renderer extension point for React, owned by the React host
 * actor `shell.react`. A contribution carries a component, so it cannot cross a worker boundary.
 */
import type { ComponentType } from "react";
import { type ActionDesc, definePoint } from "../../../kernel/index.js";

export const SHELL_REACT = "shell.react";

/** What a renderer receives: the state to show and two ways to express intent. Nothing else. */
export interface ViewProps<S, M> {
  readonly state: S;
  /** A message to the view's inbox (its owner actor). */
  send(msg: M): void;
  /** Submit an action: sends `action.msg` to `action.to` if the action is enabled. */
  dispatch(action: ActionDesc): void;
}

export interface ReactRenderer {
  readonly kind: string;
  // biome-ignore lint/suspicious/noExplicitAny: the renderer table holds every kind
  readonly component: ComponentType<ViewProps<any, any>>;
}

export const reactRenderers = definePoint<ReactRenderer>("ui.react:renderers", SHELL_REACT);
