/** Contacts renderers. */
import type { ActionItem, Dispatch } from "../../kernel/index.ts";
import {
  type ContactDetailsProps,
  type ContactEditorProps,
  type ContactsListProps,
  contactEditorIntents,
  contactsListIntents,
} from "../contacts/api/index.ts";
import type { RendererProps } from "../shell/api/react.ts";

const Action = ({ item, dispatch }: { item: ActionItem; dispatch: Dispatch }) => (
  <button
    type="button"
    disabled={!item.enabled}
    aria-busy={item.running || undefined}
    className="rounded border px-2 py-1 disabled:opacity-50"
    onClick={() => dispatch(item.msg)}
  >
    {item.label}
  </button>
);

export function ContactsList({ props, dispatch }: RendererProps<ContactsListProps>) {
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Contacts" className="flex flex-col">
        {props.rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              aria-current={row.selected || undefined}
              className="w-full px-2 py-1 text-left aria-[current]:bg-accent"
              onClick={() => dispatch(contactsListIntents.select({ id: row.id }))}
            >
              {row.name}
            </button>
          </li>
        ))}
      </ul>
      <div role="toolbar" aria-label="Contact actions" className="flex gap-2">
        {props.selectionActions.map((a) => (
          <Action key={a.id} item={a} dispatch={dispatch} />
        ))}
      </div>
    </div>
  );
}

export function ContactDetails({ props }: RendererProps<ContactDetailsProps>) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3">
      <dt>Name</dt>
      <dd>{props.contact.name}</dd>
      <dt>Email</dt>
      <dd>{props.contact.email}</dd>
      <dt>Phone</dt>
      <dd>{props.contact.phone}</dd>
    </dl>
  );
}

const FIELDS = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
] as const;

export function ContactEditor({ props, dispatch }: RendererProps<ContactEditorProps>) {
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.save.enabled) dispatch(props.save.msg);
      }}
    >
      {FIELDS.map(([field, label]) => (
        <label key={field} className="flex flex-col text-sm">
          {label}
          <input
            aria-label={label}
            className="rounded border px-2 py-1"
            value={props.draft[field]}
            onChange={(e) => dispatch(contactEditorIntents.field({ field, value: e.target.value }))}
          />
        </label>
      ))}
      {props.error && (
        <p role="alert" className="text-destructive">
          {props.error}
        </p>
      )}
      <div className="flex gap-2">
        <Action item={props.save} dispatch={dispatch} />
        <Action item={props.cancel} dispatch={dispatch} />
      </div>
    </form>
  );
}
