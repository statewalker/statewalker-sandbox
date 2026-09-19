import type { ContactDetailsView, ContactEditorView, ContactListView } from "@b/contacts/api";
import type { ViewSpec } from "@b/shell/api/spec";

/** The Contacts views as data, typed against each kind's view model. */

export const contactListSpec: ViewSpec<ContactListView> = {
  root: {
    el: "div",
    attrs: { class: "flex flex-col gap-3" },
    children: [
      {
        el: "ul",
        attrs: { "aria-label": "Contacts", class: "flex flex-col" },
        children: [
          {
            each: { read: "contacts" },
            children: [
              {
                el: "li",
                attrs: {
                  "data-contact": { item: "id" },
                  "aria-current": {
                    if: [{ eq: [{ item: "id" }, { read: "selectedId" }] }, "true"],
                  },
                  class: "cursor-pointer px-2 py-1 aria-[current=true]:bg-slate-100",
                },
                on: { click: { intent: "select", args: [{ item: "id" }] } },
                children: [{ text: { item: "name" } }],
              },
            ],
          },
        ],
      },
      { actions: "selectionActions", label: "Contact actions" },
    ],
  },
};

export const contactDetailsSpec: ViewSpec<ContactDetailsView> = {
  root: {
    when: { read: "contact" },
    children: [
      {
        el: "dl",
        attrs: {
          "data-contact-details": { read: "contact.id" },
          class: "grid grid-cols-[auto_1fr] gap-x-3",
        },
        children: [
          { el: "dt", children: ["Name"] },
          { el: "dd", children: [{ text: { read: "contact.name" } }] },
          { el: "dt", children: ["Email"] },
          { el: "dd", children: [{ text: { read: "contact.email" } }] },
          { el: "dt", children: ["Phone"] },
          { el: "dd", children: [{ text: { read: "contact.phone" } }] },
        ],
      },
    ],
  },
};

export const contactEditorSpec: ViewSpec<ContactEditorView> = {
  root: {
    el: "form",
    attrs: { class: "flex flex-col gap-2" },
    on: { submit: { submit: "save" } },
    children: [
      {
        el: "input",
        attrs: {
          "aria-label": "Name",
          class: "rounded border px-2",
          value: { read: "draft.name" },
        },
        on: { input: { intent: "editField", args: ["name", { event: "value" }] } },
      },
      {
        el: "input",
        attrs: {
          "aria-label": "Email",
          class: "rounded border px-2",
          value: { read: "draft.email" },
        },
        on: { input: { intent: "editField", args: ["email", { event: "value" }] } },
      },
      {
        el: "input",
        attrs: {
          "aria-label": "Phone",
          class: "rounded border px-2",
          value: { read: "draft.phone" },
        },
        on: { input: { intent: "editField", args: ["phone", { event: "value" }] } },
      },
      {
        when: { read: "status.errors.form" },
        children: [
          {
            el: "p",
            attrs: { role: "alert" },
            children: [{ text: { read: "status.errors.form" } }],
          },
        ],
      },
      {
        el: "div",
        attrs: { class: "flex gap-2" },
        children: [{ action: "save" }, { action: "cancel" }],
      },
    ],
  },
};
