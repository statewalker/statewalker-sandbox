import { defineCatalog, defineSchema } from "@json-render/core";
import { z } from "zod";

/**
 * The spec grammar: json-render's flat `root` + `elements` tree (the React/Solid schema), declared
 * here once for both technologies and WITHOUT `builtInActions` — `setState`, `pushState`,
 * `removeState` and `validateForm` are not part of our vocabulary. (The renderers' ActionProviders
 * still intercept them; the store adapter refuses the writes they attempt.)
 */
export const schema = defineSchema((s) => ({
  spec: s.object({
    root: s.string(),
    elements: s.record(
      s.object({
        type: s.ref("catalog.components"),
        props: s.propsOf("catalog.components"),
        children: s.array(s.string()),
        visible: { ...s.any(), ...s.optional() },
        repeat: { ...s.any(), ...s.optional() },
      }),
    ),
  }),
  catalog: s.object({
    components: s.map({
      props: s.zod(),
      slots: s.array(s.string()),
      description: s.string(),
    }),
  }),
}));

const actionState = z.object({
  label: z.string(),
  hint: z.string().optional(),
  enabled: z.boolean(),
  running: z.boolean(),
});
const data = z.record(z.string(), z.string()).optional();

/**
 * The catalog: the technology-neutral vocabulary every spec is written in. Each technology
 * implements it once (`jr.react`, `jr.solid`). Generic presentational components only — no view
 * kind, no model type appears here. No catalog actions: what a spec may invoke is decided per view
 * by its model binding (`intents`, plus the generic `submit`), not by a global vocabulary.
 */
export const catalog = defineCatalog(schema, {
  components: {
    Stack: {
      props: z.object({ direction: z.enum(["row", "column"]) }),
      slots: ["default"],
      description: "Flex container",
    },
    Toolbar: {
      props: z.object({ label: z.string() }),
      slots: ["default"],
      description: "A labelled group of buttons",
    },
    Form: { props: z.object({}), slots: ["default"], description: "Form; emits submit" },
    List: { props: z.object({ label: z.string() }), slots: ["default"], description: "List" },
    Item: {
      props: z.object({ data, current: z.boolean() }),
      slots: ["default"],
      description: "List item; emits press, or togglePress with Ctrl/Cmd",
    },
    Text: {
      props: z.object({ text: z.string(), strike: z.boolean().optional() }),
      slots: [],
      description: "Inline text",
    },
    Paragraph: { props: z.object({ text: z.string(), data }), slots: [], description: "Text" },
    Alert: { props: z.object({ text: z.string() }), slots: [], description: "An error" },
    Details: {
      props: z.object({
        data,
        entries: z.array(z.object({ term: z.string(), value: z.string() })),
      }),
      slots: [],
      description: "Term/value pairs",
    },
    TextInput: {
      props: z.object({ label: z.string(), value: z.string(), grow: z.boolean().optional() }),
      slots: [],
      description: "Text field; bind value with $bindState",
    },
    Checkbox: {
      props: z.object({ label: z.string(), checked: z.boolean() }),
      slots: [],
      description: "Checkbox; emits change and never toggles itself",
    },
    Button: {
      props: z.object({ action: actionState }),
      slots: [],
      description: "An action as a button; emits press",
    },
  },
});

export type JrCatalog = typeof catalog;
