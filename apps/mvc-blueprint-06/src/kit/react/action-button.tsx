import type { ActionDesc } from "../../kernel/index.js";

/** A button for an action description. Kit, optional: a renderer may draw its own. */
export function ActionButton(props: {
  action: ActionDesc;
  dispatch(action: ActionDesc): void;
  ariaLabel?: string;
}) {
  const { action, dispatch } = props;
  return (
    <button
      type="button"
      data-action={action.id}
      aria-label={props.ariaLabel}
      aria-busy={action.running ? true : undefined}
      disabled={!action.enabled}
      onClick={() => dispatch(action)}
    >
      {action.label}
    </button>
  );
}

export function ActionBar(props: {
  label: string;
  items: readonly { order: number; action: ActionDesc }[];
  dispatch(action: ActionDesc): void;
}) {
  const items = [...props.items].sort(
    (a, b) => a.order - b.order || a.action.id.localeCompare(b.action.id),
  );
  return (
    <div role="toolbar" aria-label={props.label} className="action-bar">
      {items.map((i) => (
        <ActionButton key={i.action.id} action={i.action} dispatch={props.dispatch} />
      ))}
    </div>
  );
}
