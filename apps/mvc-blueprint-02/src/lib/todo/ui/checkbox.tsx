import { cn } from "@statewalker/ui.view.shadcn";
import type { ComponentProps } from "react";

/** The kit ships no checkbox; a native one in the kit's tokens. */
export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 shrink-0 cursor-pointer rounded border border-input accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}
