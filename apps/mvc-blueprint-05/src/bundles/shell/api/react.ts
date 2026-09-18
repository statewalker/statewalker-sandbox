/** The React renderer extension point. Kept apart so the neutral shell API stays free of React. */
import type { ReactNode } from "react";
import { type Dispatch, definePoint, type ViewKind } from "../../../kernel/index.ts";

export interface RendererProps<P> {
  readonly props: P;
  readonly dispatch: Dispatch;
}
export interface ReactRenderer<P = unknown> {
  readonly kind: ViewKind<P>;
  readonly component: (input: RendererProps<P>) => ReactNode;
}
export const reactRenderers = definePoint<ReactRenderer>("ui.react:renderers");

/** Typed helper for a renderer contribution (the point itself is untyped by kind). */
export const renderer = <P>(
  kind: ViewKind<P>,
  component: (input: RendererProps<P>) => ReactNode,
): ReactRenderer => ({ kind, component }) as ReactRenderer;
