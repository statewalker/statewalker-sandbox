import { cn } from "@statewalker/ui.view.shadcn";
import { ToggleGroup } from "radix-ui";

/**
 * The two-option segmented control used by the BYOK FILTERS rows ("All" /
 * "Specific"). A shadcn ToggleGroup with `type="single"`, styled as a pill.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={ariaLabel}
      onValueChange={(next) => next && onChange(next as T)}
      className="inline-flex items-center rounded-md border bg-background p-0.5"
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className={cn(
            "rounded-[5px] px-2.5 py-1 font-medium text-xs transition-colors",
            "text-muted-foreground hover:text-foreground",
            "data-[state=on]:bg-brand/10 data-[state=on]:text-brand",
          )}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
