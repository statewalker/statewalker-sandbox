/** Contacts renderers. */

import { ActionBar, ActionButton } from "../../kit/react/action-button.js";
import type {
  ContactEditorMsg,
  ContactEditorState,
  ContactsListMsg,
  ContactsListState,
  DetailsState,
} from "../contacts/api/index.js";
import type { ViewProps } from "../shell/api/react.js";

export function ContactsListView({ state, send }: ViewProps<ContactsListState, ContactsListMsg>) {
  return (
    <ul className="contacts-list">
      {state.contacts.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            data-contact={c.id}
            aria-current={c.id === state.selectedId ? "true" : undefined}
            onClick={() => send({ type: "select", id: c.id })}
          >
            {c.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function DetailsView({ state, dispatch }: ViewProps<DetailsState, never>) {
  const c = state.contact;
  return (
    <div className="contact-details">
      <dl>
        <dt>Name</dt>
        <dd data-field="name">{c.name}</dd>
        <dt>Email</dt>
        <dd data-field="email">{c.email}</dd>
        <dt>Phone</dt>
        <dd data-field="phone">{c.phone}</dd>
      </dl>
      <ActionBar label="Contact actions" items={state.actions} dispatch={dispatch} />
    </div>
  );
}

const FIELDS = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
] as const;

export function ContactEditorView({
  state,
  send,
  dispatch,
}: ViewProps<ContactEditorState, ContactEditorMsg>) {
  return (
    <form
      className="contact-editor"
      onSubmit={(e) => {
        e.preventDefault();
        dispatch(state.save);
      }}
    >
      {FIELDS.map(([field, label]) => (
        <label key={field}>
          {label}
          <input
            aria-label={label}
            value={state.draft[field]}
            onChange={(e) => send({ type: "edit", field, value: e.target.value })}
          />
        </label>
      ))}
      {state.error && <p data-error>{state.error}</p>}
      <ActionButton action={state.save} dispatch={dispatch} />
      <ActionButton action={state.cancel} dispatch={dispatch} />
    </form>
  );
}
