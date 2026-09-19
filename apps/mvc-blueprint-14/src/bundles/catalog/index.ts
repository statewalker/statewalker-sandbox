import { catalogSlot, type ComponentDefinition } from "@b/catalog/api";
import { type Controller, getSlots, newRegistry } from "@kernel";
import { bindable, dyn } from "@kit/catalog";
import { z } from "zod";

const text = z.string();
const column = z.object({ key: z.string(), label: z.string() });

/**
 * `catalog`: eight generic, technology-neutral components contributed to `ui:catalog`. Nothing here
 * knows about the agent, Todos or Contacts; a React implementation lives in `catalog.ui.react`.
 */
export const definitions: Readonly<Record<string, ComponentDefinition>> = {
  Card: {
    props: z.object({ title: dyn(text) }),
    slots: ["default"],
    events: [],
    description: "A titled container; its children stack vertically.",
  },
  Stack: {
    props: z.object({ direction: z.enum(["row", "column"]).optional() }),
    slots: ["default"],
    events: [],
    description: "Lays out its children in a row or a column (default column).",
  },
  Text: {
    props: z.object({ text: dyn(text) }),
    slots: [],
    events: [],
    description: "A paragraph of plain text.",
  },
  Input: {
    props: z.object({ label: text, value: bindable(text) }),
    slots: [],
    events: [],
    description: 'A single-line text field; bind "value" to /form/<field>.',
  },
  Select: {
    props: z.object({
      label: text,
      value: bindable(text),
      options: dyn(z.array(z.object({ value: z.string(), label: z.string() }))),
    }),
    slots: [],
    events: [],
    description: 'A drop-down choice; bind "value" to /form/<field>.',
  },
  Checkbox: {
    props: z.object({ label: text, checked: bindable(z.boolean()) }),
    slots: [],
    events: [],
    description: 'A yes/no field; bind "checked" to /form/<field>.',
  },
  Button: {
    props: z.object({ label: text }),
    slots: [],
    events: ["press"],
    description: "A button; bind on.press to an action.",
  },
  Table: {
    props: z.object({
      columns: z.array(column),
      rows: dyn(z.array(z.record(z.string(), z.unknown()))),
    }),
    slots: [],
    events: [],
    description: 'A read-only table; "rows" is usually {"$state":"/data/..."}.',
  },
};

export const activate: Controller = async (context) => {
  const slots = getSlots(context);
  const [register, cleanup] = newRegistry();
  for (const [name, def] of Object.entries(definitions))
    register(slots.register(catalogSlot, name, def));
  return cleanup;
};
