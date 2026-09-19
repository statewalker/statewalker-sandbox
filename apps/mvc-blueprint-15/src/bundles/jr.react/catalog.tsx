import { defineRegistry, useBoundProp } from "@json-render/react";
import { catalog } from "@kit/jr";

const dataAttrs = (data: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));

/** The catalog, implemented once for React. Generic components; no view kind, no model. */
export const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ props, children }) => (
      <div className={props.direction === "row" ? "flex gap-2" : "flex flex-col gap-3"}>
        {children}
      </div>
    ),
    Toolbar: ({ props, children }) => (
      <div role="toolbar" aria-label={props.label} className="flex flex-wrap gap-2">
        {children}
      </div>
    ),
    Form: ({ children, emit }) => (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          emit("submit");
        }}
      >
        {children}
      </form>
    ),
    List: ({ props, children }) => (
      <ul aria-label={props.label} className="flex flex-col">
        {children}
      </ul>
    ),
    Item: ({ props, children, emit }) => (
      // biome-ignore lint/a11y/useKeyWithClickEvents: row selection; the checkbox is the keyboard path
      <li
        {...dataAttrs(props.data)}
        aria-current={props.current || undefined}
        className="flex cursor-pointer items-center gap-2 px-2 py-1 aria-[current=true]:bg-slate-100"
        onClick={(e) => emit(e.ctrlKey || e.metaKey ? "togglePress" : "press")}
      >
        {children}
      </li>
    ),
    Text: ({ props }) => (
      <span className={props.strike ? "line-through" : undefined}>{props.text}</span>
    ),
    Paragraph: ({ props }) => <p {...dataAttrs(props.data)}>{props.text}</p>,
    Alert: ({ props }) => <p role="alert">{props.text}</p>,
    Details: ({ props }) => (
      <dl {...dataAttrs(props.data)} className="grid grid-cols-[auto_1fr] gap-x-3">
        {props.entries.map((e) => [
          <dt key={`t${e.term}`}>{e.term}</dt>,
          <dd key={`d${e.term}`}>{e.value}</dd>,
        ])}
      </dl>
    ),
    TextInput: ({ props, bindings }) => {
      const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);
      return (
        <input
          aria-label={props.label}
          className={props.grow ? "flex-1 rounded border px-2" : "rounded border px-2"}
          value={value ?? ""}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    },
    Checkbox: ({ props, emit }) => (
      <input
        type="checkbox"
        aria-label={props.label}
        checked={props.checked}
        onClick={(e) => e.stopPropagation()}
        onChange={() => emit("change")}
      />
    ),
    Button: ({ props, emit }) => (
      <button
        type="button"
        className="rounded border px-3 py-1 text-sm disabled:opacity-50"
        title={props.action.hint}
        aria-busy={props.action.running}
        disabled={!props.action.enabled || props.action.running}
        onClick={() => emit("press")}
      >
        {props.action.label}
      </button>
    ),
  },
});
