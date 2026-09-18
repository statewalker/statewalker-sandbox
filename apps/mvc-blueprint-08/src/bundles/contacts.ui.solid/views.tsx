import type { ContactDetailsView, ContactEditorView, ContactListView } from "@b/contacts/api";
import { ActionBar, ActionButton, useModel } from "@kit/solid";
import { For, Show } from "solid-js";

export function ContactList(props: { model: ContactListView }) {
  const model = props.model;
  const contacts = useModel(model.getContacts, model.onContactsUpdate);
  const selected = useModel(model.getSelectedId, model.onSelectedIdUpdate);
  const actions = useModel(model.getSelectionActions, model.onSelectionActionsUpdate);
  return (
    <div class="flex flex-col gap-3">
      <ul aria-label="Contacts" class="flex flex-col">
        <For each={contacts()}>
          {(c) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: row selection
            <li
              data-contact={c.id}
              aria-current={c.id === selected() || undefined}
              class="cursor-pointer px-2 py-1 aria-[current=true]:bg-slate-100"
              onClick={() => model.select(c.id)}
            >
              {c.name}
            </li>
          )}
        </For>
      </ul>
      <ActionBar items={actions()} label="Contact actions" />
    </div>
  );
}

export function ContactDetails(props: { model: ContactDetailsView }) {
  const contact = useModel(props.model.getContact, props.model.onContactUpdate);
  return (
    <Show when={contact()}>
      {(c) => (
        <dl data-contact-details={c().id} class="grid grid-cols-[auto_1fr] gap-x-3">
          <dt>Name</dt>
          <dd>{c().name}</dd>
          <dt>Email</dt>
          <dd>{c().email}</dd>
          <dt>Phone</dt>
          <dd>{c().phone}</dd>
        </dl>
      )}
    </Show>
  );
}

const FIELDS = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
] as const;

export function ContactEditor(props: { model: ContactEditorView }) {
  const model = props.model;
  const draft = useModel(model.getDraft, model.onDraftUpdate);
  const status = useModel(model.getStatus, model.onStatusUpdate);
  return (
    <form
      class="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        model.save.submit();
      }}
    >
      <For each={FIELDS}>
        {([field, label]) => (
          <input
            aria-label={label}
            class="rounded border px-2"
            value={draft()[field]}
            onInput={(e) => model.editField(field, e.currentTarget.value)}
          />
        )}
      </For>
      <Show when={status().errors.form}>
        <p role="alert">{status().errors.form}</p>
      </Show>
      <div class="flex gap-2">
        <ActionButton action={model.save} />
        <ActionButton action={model.cancel} />
      </div>
    </form>
  );
}
