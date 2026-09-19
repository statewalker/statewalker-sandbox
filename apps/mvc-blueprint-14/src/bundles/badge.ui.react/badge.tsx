import type { CatalogRenderProps } from "@b/catalog/api/react";

export function Badge({ props }: CatalogRenderProps<{ text?: string; tone?: "info" | "warn" }>) {
  return (
    <span
      data-jr="Badge"
      data-tone={props.tone ?? "info"}
      className="rounded bg-slate-100 px-2 text-xs"
    >
      {props.text}
    </span>
  );
}
