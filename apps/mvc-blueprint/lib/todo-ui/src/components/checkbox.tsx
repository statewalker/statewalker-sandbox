import { cn } from "@statewalker/ui.view.shadcn";
import type { ComponentProps } from "react";

/**
 * `@statewalker/ui.view.shadcn` ships no checkbox, so this is a native one in
 * the kit's tokens. Native on purpose: it is focusable, labelable and
 * keyboard-operable for free, and `accent-primary` themes the tick.
 */
export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 shrink-0 cursor-pointer rounded border border-input accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
