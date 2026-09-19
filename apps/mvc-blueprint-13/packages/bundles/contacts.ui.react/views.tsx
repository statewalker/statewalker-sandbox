import type { ContactDetailsView, ContactEditorView, ContactListView } from "@p5/contacts/api";
import { ActionBar, ActionButton, useModel } from "@p5/kit-react";

export function ContactList({ model }: { model: ContactListView }) {
  const contacts = useModel(model.getContacts, model.onContactsUpdate);
  const selected = useModel(model.getSelectedId, model.onSelectedIdUpdate);
  const actions = useModel(model.getSelectionActions, model.onSelectionActionsUpdate);
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Contacts" className="flex flex-col">
        {contacts.map((c) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: row selection
          <li
            key={c.id}
            data-contact={c.id}
            aria-current={c.id === selected || undefined}
            className="cursor-pointer px-2 py-1 aria-[current=true]:bg-slate-100"
            onClick={() => model.select(c.id)}
          >
            {c.name}
          </li>
        ))}
      </ul>
      <ActionBar items={actions} label="Contact actions" />
    </div>
  );
}

export function ContactDetails({ model }: { model: ContactDetailsView }) {
  const contact = useModel(model.getContact, model.onContactUpdate);
  if (!contact) return null;
  return (
    <dl data-contact-details={contact.id} className="grid grid-cols-[auto_1fr] gap-x-3">
      <dt>Name</dt>
      <dd>{contact.name}</dd>
      <dt>Email</dt>
      <dd>{contact.email}</dd>
      <dt>Phone</dt>
      <dd>{contact.phone}</dd>
    </dl>
  );
}

const FIELDS = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
] as const;

export function ContactEditor({ model }: { model: ContactEditorView }) {
  const draft = useModel(model.getDraft, model.onDraftUpdate);
  const status = useModel(model.getStatus, model.onStatusUpdate);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        model.save.submit();
      }}
    >
      {FIELDS.map(([field, label]) => (
        <input
          key={field}
          aria-label={label}
          className="rounded border px-2"
          value={draft[field]}
          onChange={(e) => model.editField(field, e.target.value)}
        />
      ))}
      {status.errors.form && <p role="alert">{status.errors.form}</p>}
      <div className="flex gap-2">
        <ActionButton action={model.save} />
        <ActionButton action={model.cancel} />
      </div>
    </form>
  );
}
