/**
 * Recorded SpecStream responses (JSONL, one RFC 6902 patch per line), keyed by request. The
 * shape an LLM prompted with `catalog.prompt()` produces; recorded, not generated, so tests are
 * deterministic. The valid one reproduces interaction (1) through a generated UI.
 */
const lines = (...patches: object[]) => patches.map((p) => JSON.stringify(p)).join("\n");

export const todoForContact = lines(
  { op: "add", path: "/root", value: "card" },
  {
    op: "add",
    path: "/elements/card",
    value: {
      type: "Card",
      props: { title: "New todo for the selected contact" },
      children: ["intro", "people", "title", "buttons"],
    },
  },
  {
    op: "add",
    path: "/elements/intro",
    value: {
      type: "Text",
      props: { text: "One todo per selected contact. Edit the title, then press Create." },
      children: [],
    },
  },
  {
    op: "add",
    path: "/elements/people",
    value: {
      type: "Table",
      props: {
        columns: [
          { key: "name", label: "Name" },
          { key: "email", label: "Email" },
        ],
        rows: { $state: "/data/selectedContacts" },
      },
      children: [],
    },
  },
  {
    op: "add",
    path: "/elements/title",
    value: {
      type: "Input",
      props: { label: "Title", value: { $bindState: "/form/title" } },
      children: [],
    },
  },
  { op: "add", path: "/state/form", value: {} },
  { op: "add", path: "/state/form/title", value: "Call Ada Lovelace" },
  {
    op: "add",
    path: "/elements/buttons",
    value: { type: "Stack", props: { direction: "row" }, children: ["create", "open"] },
  },
  {
    op: "add",
    path: "/elements/create",
    value: {
      type: "Button",
      props: { label: "Create" },
      on: { press: { action: "todos.compose", params: { title: { $state: "/form/title" } } } },
      children: [],
    },
  },
  {
    op: "add",
    path: "/elements/open",
    value: {
      type: "Button",
      props: { label: "Open contact" },
      on: {
        press: {
          action: "contacts.edit.open",
          params: { id: { $state: "/data/selectedContacts/0/id" } },
        },
      },
      children: [],
    },
  },
);

/** The request the Assistant sends by default. */
export const DEFAULT_FIXTURES: Readonly<Record<string, string>> = {
  "Make a todo for each selected contact": todoForContact,
};
