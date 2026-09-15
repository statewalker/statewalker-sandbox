import { cn } from "@statewalker/ui.view.shadcn";
import { type ActionContribution, type SlotDeclaration, sortActions } from "@sys/extension-points";
import { useSlot } from "@ui/host";
import { useMemo } from "react";
import { ActionButton } from "./action-button.js";

/** Every action contributed to `slot`, as a toolbar. */
export function ActionBar({
  slot,
  label,
  className,
}: {
  slot: SlotDeclaration<ActionContribution>;
  label: string;
  className?: string;
}) {
  const items = useSlot(slot);
  const sorted = useMemo(() => sortActions(items), [items]);
  return (
    <div role="toolbar" aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {sorted.map((c) => (
        <ActionButton key={c.id} action={c.action} variant="outline" />
      ))}
    </div>
  );
}
