import type { ContactDetailsView, ContactEditorView, ContactListView } from "@b/contacts/api";
import { ActionBar, ActionButton, modelProp, useModel } from "@kit/vue";
import { defineComponent, h } from "vue";

export const ContactList = defineComponent({
  props: { model: modelProp<ContactListView>() },
  setup({ model }) {
    const contacts = useModel(model.getContacts, model.onContactsUpdate);
    const selected = useModel(model.getSelectedId, model.onSelectedIdUpdate);
    const actions = useModel(model.getSelectionActions, model.onSelectionActionsUpdate);
    return () =>
      h("div", { class: "flex flex-col gap-3" }, [
        h(
          "ul",
          { "aria-label": "Contacts", class: "flex flex-col" },
          contacts.value.map((c) =>
            h(
              "li",
              {
                key: c.id,
                "data-contact": c.id,
                "aria-current": c.id === selected.value || undefined,
                class: "cursor-pointer px-2 py-1 aria-[current=true]:bg-slate-100",
                onClick: () => model.select(c.id),
              },
              c.name,
            ),
          ),
        ),
        h(ActionBar, { items: actions.value, label: "Contact actions" }),
      ]);
  },
});

export const ContactDetails = defineComponent({
  props: { model: modelProp<ContactDetailsView>() },
  setup({ model }) {
    const contact = useModel(model.getContact, model.onContactUpdate);
    return () => {
      const c = contact.value;
      if (!c) return null;
      return h("dl", { "data-contact-details": c.id, class: "grid grid-cols-[auto_1fr] gap-x-3" }, [
        h("dt", "Name"),
        h("dd", c.name),
        h("dt", "Email"),
        h("dd", c.email),
        h("dt", "Phone"),
        h("dd", c.phone),
      ]);
    };
  },
});

const FIELDS = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
] as const;

export const ContactEditor = defineComponent({
  props: { model: modelProp<ContactEditorView>() },
  setup({ model }) {
    const draft = useModel(model.getDraft, model.onDraftUpdate);
    const status = useModel(model.getStatus, model.onStatusUpdate);
    return () =>
      h(
        "form",
        {
          class: "flex flex-col gap-2",
          onSubmit: (e: Event) => {
            e.preventDefault();
            model.save.submit();
          },
        },
        [
          ...FIELDS.map(([field, label]) =>
            h("input", {
              key: field,
              "aria-label": label,
              class: "rounded border px-2",
              value: draft.value[field],
              onInput: (e: Event) => model.editField(field, (e.target as HTMLInputElement).value),
            }),
          ),
          status.value.errors.form ? h("p", { role: "alert" }, status.value.errors.form) : null,
          h("div", { class: "flex gap-2" }, [
            h(ActionButton, { action: model.save }),
            h(ActionButton, { action: model.cancel }),
          ]),
        ],
      );
  },
});
