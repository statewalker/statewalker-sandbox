import { defineKeyedSlot } from "@kernel";
import type { ZodType } from "zod";

/**
 * The catalog API (J1, research option c): the technology-neutral vocabulary a generated UI may
 * use. Any bundle contributes; the agent aggregates. Declarations only.
 */

/** One component: its props schema (Zod, as json-render needs), slots, events and description. */
export interface ComponentDefinition {
  /** Props schema. Dynamic props must accept `{ "$state": … }` (see `@kit/catalog` `dyn`). */
  readonly props: ZodType;
  /** `["default"]` when the component takes children; `[]` for a leaf. */
  readonly slots: readonly string[];
  /** Events the component emits (`press`, …); an `on` binding for any other event is refused. */
  readonly events: readonly string[];
  /** What it is for — this text goes into the LLM prompt. */
  readonly description: string;
}

/** `ui:catalog` — keyed by component name (`Card`, `Button`, …). */
export const catalogSlot = defineKeyedSlot<ComponentDefinition>("ui:catalog");
