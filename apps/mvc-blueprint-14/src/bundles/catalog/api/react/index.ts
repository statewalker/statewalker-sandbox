import { type ActionView, defineKeyedSlot } from "@kernel";
import type { ComponentType, ReactNode } from "react";

/**
 * The React side of the catalog: one implementation per component name. An implementation sees
 * resolved props and two capabilities — never json-render's `emit`, its store or our models:
 * it cannot raise a built-in action, and it writes only through `write` (a bound prop).
 */
export interface CatalogRenderProps<P = Record<string, unknown>> {
  /** Props with every `$state` / `$bindState` already resolved. */
  readonly props: P;
  readonly children?: ReactNode;
  /** True while the spec is still streaming. */
  readonly loading?: boolean;
  /** The action bound to `event` on this element, if the host allowed one. */
  action(event: string): ActionView | undefined;
  /** Writes a two-way-bound prop; a no-op when the prop is not bound. */
  write(prop: string, value: unknown): void;
}

export interface ReactCatalogEntry {
  readonly component: ComponentType<CatalogRenderProps<never>>;
}

/** `ui.react:catalog` — keyed by component name, like `ui:catalog`. */
export const reactCatalogSlot = defineKeyedSlot<ReactCatalogEntry>("ui.react:catalog");
