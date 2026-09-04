/**
 * PROTOTYPE 2 — the shell's A2UI catalogue.
 *
 * A catalogue is DATA, not code: a JSON document published at a URI that
 * declares which components an agent may use. The spec is explicit that the
 * catalogId is not fetched at runtime — it is an identifier for negotiation
 * between client and agent, and both sides compile the catalogue in.
 *
 * WHY A CUSTOM CATALOGUE RATHER THAN THE BASIC ONE. A2UI's guidance is that
 * production applications define their own, restricting the agent to the
 * components and visual language that actually exist in the application.
 * For httpeers the argument is stronger than aesthetics: a peer-served
 * surface is FOREIGN CODE'S OUTPUT, and the catalogue is the enumeration of
 * everything it is permitted to express. Anything absent here cannot be
 * rendered, by construction.
 *
 * This is deliberately minimal — enough for a dialog body and a
 * notification, which are exactly the two shell commands from prototype 1
 * that take a `surface` argument.
 */

export type PropType = "string" | "boolean" | "number" | "id" | "id[]" | "enum";

export interface PropDef {
  readonly type: PropType;
  readonly required?: boolean;
  /** Allowed values when type is "enum". */
  readonly values?: readonly string[];
}

export interface ComponentDef {
  readonly props: Readonly<Record<string, PropDef>>;
  /** Prop naming the single child, if this is a single-child container. */
  readonly childProp?: string;
  /** Prop naming the child list, if this is a multi-child container. */
  readonly childrenProp?: string;
}

export interface Catalog {
  readonly catalogId: string;
  readonly components: Readonly<Record<string, ComponentDef>>;
}

/**
 * The action property, shared by interactive components.
 *
 * Actions are declared BY NAME and dispatched, never carried as closures.
 * That is what keeps a surface fully serialisable, and it is also what makes
 * a foreign peer's surface safe to accept: an action name is a request, and
 * the shell decides what — if anything — it maps to.
 */
const ACTION: PropDef = { type: "string" };

export const shellCatalog: Catalog = {
  catalogId: "https://httpeers.dev/catalogs/shell/v1/catalog.json",
  components: {
    // --- content ---
    Text: {
      props: {
        text: { type: "string", required: true },
        variant: { type: "enum", values: ["body", "h1", "h2", "caption"] },
      },
    },

    // --- layout ---
    Column: {
      props: { children: { type: "id[]", required: true } },
      childrenProp: "children",
    },
    Row: {
      props: { children: { type: "id[]", required: true } },
      childrenProp: "children",
    },
    Divider: { props: {} },

    // --- input ---
    Button: {
      props: {
        child: { type: "id", required: true },
        variant: { type: "enum", values: ["primary", "secondary", "danger"] },
        action: ACTION,
      },
      childProp: "child",
    },
    TextField: {
      props: {
        value: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        action: ACTION,
      },
    },
  },
};
