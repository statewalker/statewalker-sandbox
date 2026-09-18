/** The React renderer extension point (§14.2) — the only React-typed part of the shell API. */
import type { ComponentType } from "react";
import { defineService } from "../../../kernel/context.js";
import type { ViewKind } from "../../../kernel/models.js";
import { defineKeyedSlot } from "../../../kernel/slots.js";

export interface ReactRenderer<M = unknown> {
  readonly kind: ViewKind<M>;
  // biome-ignore lint/suspicious/noExplicitAny: the host pairs a model with its kind's renderer
  readonly component: ComponentType<{ model: any }>;
}
export const reactRenderersSlot = defineKeyedSlot<ReactRenderer>("ui.react:renderers");

/** Typed registration helper signature: keeps `component`'s prop type tied to the kind. */
export const reactRenderer = <M>(
  kind: ViewKind<M>,
  component: ComponentType<{ model: M }>,
): ReactRenderer<M> => ({ kind, component });

/** Where the React shell host mounts. The application sets it before activation. */
export const [getReactRoot, setReactRoot] = defineService<HTMLElement>("shell.react:root");
