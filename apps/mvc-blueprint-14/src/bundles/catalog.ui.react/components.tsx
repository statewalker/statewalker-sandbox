import type { CatalogRenderProps } from "@b/catalog/api/react";
import type { ActionView } from "@kernel";
import { useModel } from "@kit/react";
import type { ComponentType } from "react";

/**
 * Generic presentational components. Each renders resolved props; inputs are CONTROLLED by the
 * bound value (no private copy of state — unlike the shadcn binding's `useState` fallback), and a
 * button submits the ActionView the host bound to its `press`, or renders disabled.
 */
type Props<P> = CatalogRenderProps<P>;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

function Card({ props, children }: Props<{ title?: string }>) {
  return (
    <section data-jr="Card" className="flex flex-col gap-2 rounded border p-3">
      <h3 className="font-semibold">{props.title}</h3>
      {children}
    </section>
  );
}

function Stack({ props, children }: Props<{ direction?: "row" | "column" }>) {
  return (
    <div
      data-jr="Stack"
      className={props.direction === "row" ? "flex gap-2" : "flex flex-col gap-2"}
    >
      {children}
    </div>
  );
}

function Text({ props }: Props<{ text?: string }>) {
  return <p data-jr="Text">{str(props.text)}</p>;
}

function Input({ props, write }: Props<{ label?: string; value?: unknown }>) {
  return (
    <label data-jr="Input" className="flex flex-col text-sm">
      {props.label}
      <input
        className="rounded border px-2 py-1"
        value={str(props.value)}
        onChange={(e) => write("value", e.target.value)}
      />
    </label>
  );
}

function Select({
  props,
  write,
}: Props<{ label?: string; value?: unknown; options?: { value: string; label: string }[] }>) {
  return (
    <label data-jr="Select" className="flex flex-col text-sm">
      {props.label}
      <select value={str(props.value)} onChange={(e) => write("value", e.target.value)}>
        {(props.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Checkbox({ props, write }: Props<{ label?: string; checked?: unknown }>) {
  return (
    <label data-jr="Checkbox" className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={props.checked === true}
        onChange={(e) => write("checked", e.target.checked)}
      />
      {props.label}
    </label>
  );
}

function BoundButton({ label, view }: { label: string; view: ActionView }) {
  const state = useModel(view.getState, view.onStateUpdate);
  return (
    <button
      type="button"
      data-jr="Button"
      className="rounded border px-3 py-1 text-sm disabled:opacity-50"
      aria-busy={state.running}
      disabled={!state.enabled || state.running}
      onClick={() => view.submit()}
    >
      {label}
    </button>
  );
}

function Button({ props, action }: Props<{ label?: string }>) {
  const view = action("press");
  const label = str(props.label);
  return view ? (
    <BoundButton label={label} view={view} />
  ) : (
    <button type="button" data-jr="Button" className="rounded border px-3 py-1 text-sm" disabled>
      {label}
    </button>
  );
}

function Table({
  props,
}: Props<{ columns?: { key: string; label: string }[]; rows?: Record<string, unknown>[] }>) {
  const columns = props.columns ?? [];
  const rows = Array.isArray(props.rows) ? props.rows : [];
  return (
    <table data-jr="Table" className="text-sm">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className="pr-3 text-left">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: generated rows carry no guaranteed id
          <tr key={i}>
            {columns.map((c) => (
              <td key={c.key} className="pr-3">
                {str(row[c.key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const implementations: Readonly<Record<string, ComponentType<Props<never>>>> = {
  Card,
  Stack,
  Text,
  Input,
  Select,
  Checkbox,
  Button,
  Table,
} as never;
