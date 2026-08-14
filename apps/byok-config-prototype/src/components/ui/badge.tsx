import { cn } from "@statewalker/ui.view.shadcn";
import type * as React from "react";

/** shadcn Badge — not yet part of `@statewalker/ui.view.shadcn`. */
export function Badge({
  className,
  variant = "secondary",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: "secondary" | "outline" | "brand" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-medium text-xs",
        variant === "secondary" && "border-transparent bg-secondary text-secondary-foreground",
        variant === "outline" && "text-muted-foreground",
        variant === "brand" && "border-brand/30 bg-brand/10 text-brand",
        className,
      )}
      {...props}
    />
  );
}
