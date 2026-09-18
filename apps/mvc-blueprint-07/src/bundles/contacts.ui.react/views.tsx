import { ActionButton } from "../../kit/react/action-button.js";
import { useModel } from "../../kit/react/use-model.js";
import type {
  ContactDetailsView,
  ContactDraft,
  ContactEditorView,
  ContactsListView,
} from "../contacts/api/index.js";

export function ContactList({ model }: { model: ContactsListView }) {
  const items = useModel(model.getItems, model.onItemsUpdate);
  const actions = useModel(model.getActions, model.onActionsUpdate);
  return (
    <div className="contacts">
      <ul aria-label="Contacts">
        {items.map((c) => (
          <li key={c.id} aria-current={c.selected || undefined}>
            <button type="button" onClick={() => model.select(c.id)}>
              {c.name}
            </button>
          </li>
        ))}
      </ul>
      <div role="toolbar" aria-label="Contact actions">
        {actions.map((entry) => (
          <ActionButton key={entry.id} action={entry.action} />
        ))}
      </div>
    </div>
  );
}

export function ContactDetails({ model }: { model: ContactDetailsView }) {
  const contact = useModel(model.getContact, model.onContactUpdate);
  if (!contact) return null;
  return (
    <dl>
      <dt>Name</dt>
      <dd data-field="name">{contact.name}</dd>
      <dt>Email</dt>
      <dd>{contact.email}</dd>
      <dt>Phone</dt>
      <dd>{contact.phone}</dd>
    </dl>
  );
}

const FIELDS: ReadonlyArray<[keyof ContactDraft, string]> = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
];

export function ContactEditor({ model }: { model: ContactEditorView }) {
  const draft = useModel(model.getDraft, model.onDraftUpdate);
  const status = useModel(model.getStatus, model.onStatusUpdate);
  return (
    <div className="editor">
      {FIELDS.map(([field, label]) => (
        <label key={field}>
          {label}
          <input
            aria-label={label}
            value={draft[field]}
            onChange={(e) => model.editField(field, e.target.value)}
          />
        </label>
      ))}
      {status.error && <p role="alert">{status.error}</p>}
      <ActionButton action={model.save} />
      <ActionButton action={model.cancel} />
    </div>
  );
}
