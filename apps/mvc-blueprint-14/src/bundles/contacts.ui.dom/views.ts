import type { ContactDetailsView, ContactEditorView, ContactListView } from "@b/contacts/api";
import { actionBar, actionButton, bind, h, newScope, setValue } from "@kit/dom";

export function mountContactList(host: HTMLElement, model: ContactListView): () => void {
  const scope = newScope();
  const list = h("ul", { "aria-label": "Contacts", class: "flex flex-col" });
  const bar = actionBar(
    model.getSelectionActions,
    model.onSelectionActionsUpdate,
    "Contact actions",
  );
  scope.own(bar.dispose);
  host.append(h("div", { class: "flex flex-col gap-3" }, list, bar.el));
  const render = () => {
    const selected = model.getSelectedId();
    list.replaceChildren(
      ...model.getContacts().map((c) =>
        h(
          "li",
          {
            "data-contact": c.id,
            "aria-current": c.id === selected ? "true" : undefined,
            class: "cursor-pointer px-2 py-1 aria-[current=true]:bg-slate-100",
            onclick: () => model.select(c.id),
          },
          c.name,
        ),
      ),
    );
  };
  scope.own(bind(model.getContacts, model.onContactsUpdate, render));
  scope.own(bind(model.getSelectedId, model.onSelectedIdUpdate, render));
  return () => {
    scope.dispose();
    host.replaceChildren();
  };
}

export function mountContactDetails(host: HTMLElement, model: ContactDetailsView): () => void {
  const dl = h("dl", { class: "grid grid-cols-[auto_1fr] gap-x-3" });
  host.append(dl);
  const off = bind(model.getContact, model.onContactUpdate, (c) => {
    if (!c) return dl.replaceChildren();
    dl.dataset.contactDetails = c.id;
    dl.replaceChildren(
      ...(
        [
          ["Name", c.name],
          ["Email", c.email],
          ["Phone", c.phone],
        ] as const
      ).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]),
    );
  });
  return () => {
    off();
    host.replaceChildren();
  };
}

const FIELDS = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
] as const;

export function mountContactEditor(host: HTMLElement, model: ContactEditorView): () => void {
  const scope = newScope();
  const inputs = FIELDS.map(([field, label]) => {
    const input = h("input", {
      "aria-label": label,
      class: "rounded border px-2",
      oninput: (e) => model.editField(field, (e.target as HTMLInputElement).value),
    });
    return [field, input] as const;
  });
  const error = h("p", { role: "alert" });
  const save = actionButton(model.save);
  const cancel = actionButton(model.cancel);
  scope.own(save.dispose);
  scope.own(cancel.dispose);
  host.append(
    h(
      "form",
      {
        class: "flex flex-col gap-2",
        onsubmit: (e) => {
          e.preventDefault();
          model.save.submit();
        },
      },
      ...inputs.map(([, input]) => input),
      error,
      h("div", { class: "flex gap-2" }, save.el, cancel.el),
    ),
  );
  scope.own(
    bind(model.getDraft, model.onDraftUpdate, (d) => {
      for (const [field, input] of inputs) setValue(input, d[field]);
    }),
  );
  scope.own(
    bind(model.getStatus, model.onStatusUpdate, (s) => {
      error.hidden = !s.errors.form;
      error.textContent = s.errors.form ?? "";
    }),
  );
  return () => {
    scope.dispose();
    host.replaceChildren();
  };
}
