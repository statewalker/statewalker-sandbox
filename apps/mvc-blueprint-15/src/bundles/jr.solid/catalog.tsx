/** @jsxImportSource solid-js */
import { defineRegistry, useBoundProp } from "@json-render/solid";
import { catalog } from "@kit/jr";
import { For } from "solid-js";

const dataAttrs = (data: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));

/**
 * The catalog, implemented once for Solid. `c.props` is a getter over the resolved element: read
 * it inside JSX (never destructure it in setup) or the component stops following the model.
 */
export const { registry } = defineRegistry(catalog, {
  components: {
    Stack: (c) => (
      <div class={c.props.direction === "row" ? "flex gap-2" : "flex flex-col gap-3"}>
        {c.children}
      </div>
    ),
    Toolbar: (c) => (
      <div role="toolbar" aria-label={c.props.label} class="flex flex-wrap gap-2">
        {c.children}
      </div>
    ),
    Form: (c) => (
      <form
        class="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          c.emit("submit");
        }}
      >
        {c.children}
      </form>
    ),
    List: (c) => (
      <ul aria-label={c.props.label} class="flex flex-col">
        {c.children}
      </ul>
    ),
    Item: (c) => (
      // biome-ignore lint/a11y/useKeyWithClickEvents: row selection; the checkbox is the keyboard path
      <li
        {...dataAttrs(c.props.data)}
        aria-current={c.props.current || undefined}
        class="flex cursor-pointer items-center gap-2 px-2 py-1 aria-[current=true]:bg-slate-100"
        onClick={(e) => c.emit(e.ctrlKey || e.metaKey ? "togglePress" : "press")}
      >
        {c.children}
      </li>
    ),
    Text: (c) => <span class={c.props.strike ? "line-through" : undefined}>{c.props.text}</span>,
    Paragraph: (c) => <p {...dataAttrs(c.props.data)}>{c.props.text}</p>,
    Alert: (c) => <p role="alert">{c.props.text}</p>,
    Details: (c) => (
      <dl {...dataAttrs(c.props.data)} class="grid grid-cols-[auto_1fr] gap-x-3">
        <For each={c.props.entries}>
          {(e) => (
            <>
              <dt>{e.term}</dt>
              <dd>{e.value}</dd>
            </>
          )}
        </For>
      </dl>
    ),
    TextInput: (c) => {
      const [, setValue] = useBoundProp<string>(c.props.value, c.bindings?.value);
      return (
        <input
          aria-label={c.props.label}
          class={c.props.grow ? "flex-1 rounded border px-2" : "rounded border px-2"}
          value={c.props.value ?? ""}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      );
    },
    Checkbox: (c) => (
      <input
        type="checkbox"
        aria-label={c.props.label}
        checked={c.props.checked}
        onClick={(e) => {
          e.stopPropagation();
          // Controlled: the model decides; the DOM toggled itself already, so put it back.
          e.currentTarget.checked = c.props.checked;
          c.emit("change");
        }}
      />
    ),
    Button: (c) => (
      <button
        type="button"
        class="rounded border px-3 py-1 text-sm disabled:opacity-50"
        title={c.props.action.hint}
        aria-busy={c.props.action.running}
        disabled={!c.props.action.enabled || c.props.action.running}
        onClick={() => c.emit("press")}
      >
        {c.props.action.label}
      </button>
    ),
  },
});
